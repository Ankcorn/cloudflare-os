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
//
// Known residual risk: DNS rebinding. We validate the textual hostname against a block list,
// but the runtime resolves DNS independently when actually issuing the fetch (and again on
// each redirect hop). A hostile authoritative server can return a public IP at validation
// time and a private/metadata IP at fetch time. Mitigating this properly requires resolving
// once and pinning the IP for the request, which the Workers `fetch()` API doesn't currently
// support. The mitigations we *do* have are: (a) no credentials/cookies/auth headers are
// forwarded, so a rebound metadata endpoint can't easily exfiltrate secrets via this path;
// (b) the response is treated as untrusted free-form content in the audit log; (c) bodies
// are capped so the rebound endpoint can't dump arbitrary data into the agent. This is
// considered acceptable for now given those mitigations.

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

// Normalize a hostname for block-list matching. The WHATWG URL parser preserves trailing
// dots on hostnames (they denote an absolute FQDN), e.g. `new URL("https://localhost./")
// .hostname === "localhost."`. DNS resolvers strip the trailing dot before lookup, so
// `localhost.` resolves to 127.0.0.1 just like `localhost`. We must strip trailing dots
// before matching, or the block list is trivially bypassed.
function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

// Block IP literals entirely. Web servers worth fetching from have real hostnames.
function isIpLiteral(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (h.startsWith("[") && h.endsWith("]")) return true; // IPv6 in URL
  // IPv4 dotted-decimal
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) return true;
  // IPv6 without brackets (URL.host strips them in some runtimes)
  if (h.includes(":")) return true;
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname);
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
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  const body = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(combined);
  return { body, truncated };
}

// Maximum input size we'll attempt to convert to Markdown. Larger inputs are truncated at
// this boundary before conversion. The byte cap on the raw body is much larger (5 MiB), but
// htmlToMarkdown runs ~20 sequential full-string `replace()` passes, so we apply a tighter
// cap here to keep CPU and memory bounded under adversarial input.
const MARKDOWN_INPUT_CAP = 512 * 1024;

// Cap on how far each inline-content lazy quantifier (`[\s\S]{0,N}?`) is allowed to scan
// before giving up. Without this, an unclosed `<a>` / `<strong>` / `<em>` in attacker-
// controlled HTML can force the engine to scan to end-of-string for every such tag,
// degenerating to O(n*m) work. 50 KiB is well above any reasonable inline-content length.
const INLINE_LAZY_LIMIT = 50000;

// Convert HTML to a reasonable Markdown approximation. Hand-rolled so we avoid pulling in a
// new dependency. Not perfect — strips most attributes, ignores CSS, doesn't try to interpret
// JavaScript-rendered content — but adequate for the agent's "look up a doc page" use case.
export function htmlToMarkdown(html: string): string {
  // Cap input before doing anything heavy. The truncation point is best-effort: we cut at
  // the cap regardless of tag boundaries (the subsequent regex pipeline tolerates dangling
  // partial tags by simply not matching them).
  let s = html.length > MARKDOWN_INPUT_CAP ? html.slice(0, MARKDOWN_INPUT_CAP) : html;

  // Drop scripts, styles, noscripts, and HTML comments entirely.
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

  // Links: capture href and text. Bound the inner-content quantifier; an unclosed `<a>` tag
  // in adversarial input can otherwise force scans to end-of-string.
  s = s.replace(
    new RegExp(
      `<a\\b[^>]*href\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))[^>]*>([\\s\\S]{0,${INLINE_LAZY_LIMIT}}?)<\\/a>`,
      "gi",
    ),
    (_m, _q, dq, sq, bare, text) => {
      const href = (dq ?? sq ?? bare ?? "").trim();
      const inner = stripTags(text).trim();
      if (!href) return inner;
      if (!inner) return href;
      return `[${inner}](${href})`;
    },
  );

  // Images: alt + src. The src regex has four capture groups:
  //   [1] whole quoted-or-bare value
  //   [2] double-quoted content
  //   [3] single-quoted content
  //   [4] bare (unquoted) value
  s = s.replace(
    /<img\b[^>]*>/gi,
    (m) => {
      const alt = /alt\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m);
      const src = /src\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m);
      const altText = (alt?.[2] ?? alt?.[3] ?? "").trim();
      const srcUrl = (src?.[2] ?? src?.[3] ?? src?.[4] ?? "").trim();
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

  // Bold / italic. Split into separate matchers per tag (rather than using a `\1` backref
  // with a lazy `[\s\S]*?`) and bound the inner-content quantifier, for the same reason
  // as the `<a>` regex above.
  const boldItalicPairs: Array<[string, string, string]> = [
    ["strong", "**", "**"],
    ["b", "**", "**"],
    ["em", "*", "*"],
    ["i", "*", "*"],
  ];
  for (const [tag, open, close] of boldItalicPairs) {
    const re = new RegExp(
      `<${tag}\\b[^>]*>([\\s\\S]{0,${INLINE_LAZY_LIMIT}}?)<\\/${tag}>`,
      "gi",
    );
    s = s.replace(re, (_m, inner) => `${open}${stripTags(inner)}${close}`);
  }

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
// against the SSRF block-list. Returns both the final response and the URL it came from, so
// the audit log can be accurate even if `response.url` happens to be empty.
async function followRedirects(
  startUrl: URL,
  abortSignal: AbortSignal,
): Promise<{ response: Response; finalUrl: URL }> {
  let url = startUrl;
  // i=0 is the initial fetch; i=1..MAX_REDIRECTS are redirect hops. Total iterations is
  // therefore MAX_REDIRECTS + 1, and we allow up to MAX_REDIRECTS redirects before failing.
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
        return { response, finalUrl: url }; // No location header; return as-is.
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

    return { response, finalUrl: url };
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
  let postRedirectUrl: URL;
  try {
    const r = await followRedirects(parsed, abortController.signal);
    response = r.response;
    postRedirectUrl = r.finalUrl;
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

  // Prefer `response.url` (set by the runtime when redirects were followed) but fall back
  // to the post-redirect URL we tracked ourselves so the audit log is always accurate.
  const finalUrl = response.url || postRedirectUrl.toString();
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
