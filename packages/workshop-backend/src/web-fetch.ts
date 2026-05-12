// Built-in WebFetch capability for the agent.
//
// Provides an HTTP GET against arbitrary public HTTPS URLs, with hard server-side limits to
// guard against SSRF and data-exfiltration vectors. There is intentionally no support for
// POST/PUT/DELETE/PATCH or for forwarding credentials. Bodies are returned to the agent as
// Markdown by default, but text/html/json passthrough is also supported.
//
// Each successful fetch is recorded as an Overseer "observation" (see
// `OverseerImpl.recordAgentObservation()`), tagged with `freeFormContent: true` and
// `untrustedSource: { kind: "web", origin }` so that future policy machinery can track which
// external influencers the agent has been exposed to during a turn.

export type WebFetchAccept = "markdown" | "text" | "html" | "json";

export type WebFetchInput = {
  url: string;
  accept?: WebFetchAccept;
  // Caller-requested cap on body length (characters). Server enforces its own hard cap on top.
  maxBytes?: number;
};

export type WebFetchResult = {
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  truncated: boolean;
};

// Hard server-side limits.
const HARD_MAX_BYTES = 5 * 1024 * 1024;     // 5 MiB after which we always truncate
const DEFAULT_MAX_BYTES = 1 * 1024 * 1024;  // 1 MiB default cap when caller didn't specify
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "GadgetsWebFetch/1.0";

// Hosts and host patterns that are never allowed, to guard against SSRF / leaking secrets to
// cloud-metadata or local services.
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata",
]);

// Block IP literals entirely. Web servers worth fetching from have real hostnames.
function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true; // IPv6 in URL
  // IPv4 dotted-decimal
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return true;
  // IPv6 without brackets (URL.host strips them in some runtimes)
  if (hostname.includes(":")) return true;
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  // Block bare hostnames without a dot (e.g. internal short names).
  if (!h.includes(".")) return true;
  // Block .local, .internal, .lan, .home, .corp, .intranet TLDs.
  if (
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".lan") ||
    h.endsWith(".home") ||
    h.endsWith(".corp") ||
    h.endsWith(".intranet") ||
    h.endsWith(".localhost")
  ) {
    return true;
  }
  return false;
}

// Validate a URL string for use with webFetch. Throws on bad input.
// Returns the parsed URL on success.
export function validateWebFetchUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  if (parsed.protocol !== "https:") {
    throw new Error(
      `Only https:// URLs are allowed; got ${parsed.protocol}//. ` +
        `Use the HTTPS version of this URL.`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }

  if (isIpLiteral(parsed.hostname)) {
    throw new Error(
      `URLs targeting IP literals are not allowed: ${parsed.hostname}`,
    );
  }

  if (isBlockedHostname(parsed.hostname)) {
    throw new Error(
      `Refusing to fetch from blocked host: ${parsed.hostname}`,
    );
  }

  return parsed;
}

// Read up to `maxBytes` from the body of a response. Returns the body as a string (decoded as
// UTF-8) and a flag indicating whether it was truncated.
async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) {
    return { body: "", truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (total + value.byteLength > maxBytes) {
        // Take a partial slice to fill the budget exactly, then stop.
        const remaining = maxBytes - total;
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
        }
        truncated = true;
        break;
      }

      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // If we stopped early, cancel the rest of the stream to free server-side resources.
    if (truncated) {
      try {
        await reader.cancel();
      } catch {
        // Ignore.
      }
    }
    reader.releaseLock();
  }

  // Concatenate and decode as UTF-8 with replacement of invalid sequences.
  const total2 = chunks.reduce((n, c) => n + c.byteLength, 0);
  const combined = new Uint8Array(total2);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  const body = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(combined);
  return { body, truncated };
}

// Convert HTML to a reasonable Markdown approximation. Hand-rolled so we avoid pulling in a
// new dependency. Not perfect — strips most attributes, ignores CSS, doesn't try to interpret
// JavaScript-rendered content — but adequate for the agent's "look up a doc page" use case.
export function htmlToMarkdown(html: string): string {
  // Drop scripts, styles, noscripts, and HTML comments entirely.
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");
  s = s.replace(/<svg\b[\s\S]*?<\/svg>/gi, "");

  // Common block conversions. Order matters — handle pre/code before generic block handling.
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => {
    const stripped = stripTags(inner);
    return `\n\n\`\`\`\n${stripped.trim()}\n\`\`\`\n\n`;
  });

  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner) => {
    return `\`${stripTags(inner).replace(/`/g, "\\`")}\``;
  });

  // Headings
  for (let level = 1; level <= 6; level++) {
    const tag = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi");
    s = s.replace(tag, (_m, inner) =>
      `\n\n${"#".repeat(level)} ${stripTags(inner).trim()}\n\n`,
    );
  }

  // Links: capture href and text.
  s = s.replace(
    /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, _q, dq, sq, bare, text) => {
      const href = (dq ?? sq ?? bare ?? "").trim();
      const inner = stripTags(text).trim();
      if (!href) return inner;
      if (!inner) return href;
      return `[${inner}](${href})`;
    },
  );

  // Images: alt + src.
  s = s.replace(
    /<img\b[^>]*>/gi,
    (m) => {
      const alt = /alt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m);
      const src = /src\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m);
      const altText = (alt?.[2] ?? alt?.[3] ?? "").trim();
      const srcUrl = (src?.[2] ?? src?.[3] ?? src?.[5] ?? "").trim();
      if (!srcUrl) return "";
      return `![${altText}](${srcUrl})`;
    },
  );

  // Lists. Quick-and-dirty: <li> becomes "- " on its own line. We don't try to track ordered
  // vs unordered or nesting depth — the LLM is fine with bullet lists either way.
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<\/li>/gi, "");

  // Block separators.
  s = s.replace(/<\/?(p|div|section|article|header|footer|aside|nav|main|tr|table|thead|tbody|tfoot|ul|ol|blockquote)[^>]*>/gi, "\n\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<hr\s*\/?>/gi, "\n\n---\n\n");

  // Bold / italic.
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `**${stripTags(inner)}**`);
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner) => `*${stripTags(inner)}*`);

  // Drop any remaining tags.
  s = stripTags(s);

  // Decode a handful of HTML entities.
  s = decodeEntities(s);

  // Collapse excess whitespace. Multiple blank lines → one blank line; trim each line's trailing
  // whitespace.
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();

  return s;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => {
      const code = parseInt(n, 10);
      if (!isFinite(code) || code < 0 || code > 0x10ffff) return _m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return _m;
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n) => {
      const code = parseInt(n, 16);
      if (!isFinite(code) || code < 0 || code > 0x10ffff) return _m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return _m;
      }
    });
}

// Strip tags from HTML and return text content. Used for `accept: "text"`.
export function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, "");
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, "");
  s = stripTags(s);
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// Issue the fetch with manual redirect handling so we can re-validate each hop's destination
// against the SSRF block-list.
async function followRedirects(
  startUrl: URL,
  abortSignal: AbortSignal,
): Promise<Response> {
  let url = startUrl;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const response = await fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": USER_AGENT,
        "accept": "text/html,text/plain,application/json,application/xhtml+xml,*/*;q=0.8",
      },
      signal: abortSignal,
    });

    const status = response.status;
    if (status >= 300 && status < 400) {
      const loc = response.headers.get("location");
      if (!loc) {
        return response; // No location header; return as-is.
      }
      // Drain the body so we don't leak the previous response.
      try {
        await response.body?.cancel();
      } catch {
        // Ignore.
      }
      const next = new URL(loc, url);
      // Re-validate every redirect hop.
      validateWebFetchUrl(next.toString());
      url = next;
      continue;
    }

    return response;
  }

  throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}

export async function webFetch(input: WebFetchInput): Promise<WebFetchResult> {
  const parsed = validateWebFetchUrl(input.url);

  const requestedMax = input.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxBytes = Math.min(
    Math.max(1, Math.floor(requestedMax)),
    HARD_MAX_BYTES,
  );

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await followRedirects(parsed, abortController.signal);
  } catch (err) {
    if (
      err instanceof Error &&
      (err.name === "AbortError" || /abort/i.test(err.message))
    ) {
      throw new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  const finalUrl = response.url || parsed.toString();
  const contentType = response.headers.get("content-type") ?? "";

  const { body: rawBody, truncated } = await readBodyCapped(response, maxBytes);

  const accept: WebFetchAccept = input.accept ?? "markdown";
  let body = rawBody;

  const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType);

  switch (accept) {
    case "markdown":
      body = isHtml ? htmlToMarkdown(rawBody) : rawBody;
      break;
    case "text":
      body = isHtml ? htmlToText(rawBody) : rawBody;
      break;
    case "html":
    case "json":
      body = rawBody;
      break;
  }

  return {
    status: response.status,
    finalUrl,
    contentType,
    body,
    truncated,
  };
}
