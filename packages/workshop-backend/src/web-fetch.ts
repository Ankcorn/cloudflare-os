// Built-in WebFetch capability for the agent.
//
// Provides an HTTP GET against arbitrary public HTTPS URLs, with hard server-side limits to
// guard against SSRF and data-exfiltration vectors. There is intentionally no support for
// POST/PUT/DELETE/PATCH or for forwarding credentials.
//
// Document-to-Markdown conversion is delegated to Cloudflare Workers AI's
// `env.WORKERS_AI.toMarkdown()` utility, which handles HTML, PDF, DOCX, XLSX/XLS, ODT/ODS,
// CSV, XML, and Apple Numbers documents. Image conversion is intentionally NOT exposed here
// because it uses paid Workers AI models. Plain-text, JSON, and other unknown content types
// pass through unconverted.
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

import type { AiGatewayConfig } from "./ai-gateway";

// The bits of the Workers AI binding and gateway config that `webFetch` needs. Kept narrow
// so the caller can pass a stub in tests without constructing a full Cloudflare.Env.
export type WebFetchEnv = {
  ai: Ai;
  gateway: AiGatewayConfig | null;
};

export type WebFetchAccept = "markdown" | "html" | "json";

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

// Read up to `maxBytes` from the body of a response. Returns the raw bytes (so callers can
// hand them to either a text decoder or a Blob) and a flag indicating whether the stream
// was truncated.
async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) {
    return { bytes: new Uint8Array(0), truncated: false };
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

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes: combined, truncated };
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes);
}

// Strip parameters from a Content-Type header (e.g. `text/html; charset=utf-8` -> `text/html`).
function baseContentType(contentType: string): string {
  const i = contentType.indexOf(";");
  return (i >= 0 ? contentType.slice(0, i) : contentType).trim().toLowerCase();
}

// MIME types that `env.WORKERS_AI.toMarkdown()` can convert for free (no Workers AI model
// usage). Derived from the public list of supported formats:
// https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/
//
// Image MIME types are intentionally excluded -- image conversion uses paid Workers AI
// models (object detection + Gemma-3 for image-to-text), and we don't want webFetch to
// silently incur per-fetch costs.
const TO_MARKDOWN_MIME_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "application/pdf",
  "application/xml",
  "text/xml",
  "text/csv",
  // Office / OpenDocument
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",       // .xlsx
  "application/vnd.ms-excel",                                                // .xls
  "application/vnd.ms-excel.sheet.macroenabled.12",                          // .xlsm
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",                   // .xlsb
  "application/vnd.oasis.opendocument.spreadsheet",                          // .ods
  "application/vnd.oasis.opendocument.text",                                 // .odt
  "application/vnd.apple.numbers",                                           // .numbers
]);

// Build the gateway options object that pairs `toMarkdown()` calls with the project's
// AI Gateway, mirroring how the LLM path in `ai-models.ts` does it. Returns undefined when
// AI Gateway mode isn't enabled, in which case `toMarkdown` runs against Workers AI
// directly.
function buildGatewayOptions(
  gateway: AiGatewayConfig | null,
): GatewayOptions | undefined {
  if (!gateway) return undefined;
  // We use the Workers-AI-specific gateway (CF_AI_GATEWAY_WAI) when set, falling back to
  // the general gateway. `toMarkdown` invokes Workers AI models under the hood for any
  // paid sub-tasks (e.g. embedded image summarization), so it's the right destination.
  return {
    id: gateway.workersAiGateway,
    metadata: { tool: "webFetch", automated: true },
  };
}

// Attempt to convert a document to Markdown using the Workers AI binding. Returns the
// Markdown body on success, or null if the document's MIME type isn't in the supported
// allow-list. Throws (with a contextual error) if the conversion itself fails.
async function convertToMarkdown(
  env: WebFetchEnv,
  bytes: Uint8Array,
  contentType: string,
  url: URL,
): Promise<string | null> {
  const mime = baseContentType(contentType);
  if (!TO_MARKDOWN_MIME_TYPES.has(mime)) {
    return null;
  }

  // Build a name from the URL path so toMarkdown's format detection has a hint.
  const pathBasename = url.pathname.split("/").filter(Boolean).pop() || "document";

  const result = await env.ai.toMarkdown(
    {
      name: pathBasename,
      blob: new Blob([bytes], { type: mime }),
    },
    {
      gateway: buildGatewayOptions(env.gateway),
      conversionOptions: {
        // Resolve relative links against the page's own origin.
        html: {
          hostname: url.origin,
          // Skip per-image summarization (which would invoke paid Workers AI models). The
          // agent gets a Markdown skeleton with image alt text and src URLs, which is
          // sufficient for documentation-lookup use cases.
          images: { convert: false, convertOGImage: false },
        },
      },
    },
  );

  if (result.format === "error") {
    throw new Error(`Markdown conversion failed: ${result.error}`);
  }
  return result.data;
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

export async function webFetch(
  env: WebFetchEnv,
  input: WebFetchInput,
): Promise<WebFetchResult> {
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
  const finalUrlStr = response.url || postRedirectUrl.toString();
  let finalUrlParsed: URL;
  try {
    finalUrlParsed = new URL(finalUrlStr);
  } catch {
    finalUrlParsed = postRedirectUrl;
  }
  const contentType = response.headers.get("content-type") ?? "";

  const { bytes, truncated } = await readBodyCapped(response, maxBytes);

  const accept: WebFetchAccept = input.accept ?? "markdown";
  let body: string;

  switch (accept) {
    case "markdown": {
      const md = await convertToMarkdown(env, bytes, contentType, finalUrlParsed);
      body = md !== null ? md : decodeUtf8(bytes);
      break;
    }
    case "html":
    case "json":
      body = decodeUtf8(bytes);
      break;
  }

  return {
    status: response.status,
    finalUrl: finalUrlStr,
    contentType,
    body,
    truncated,
  };
}
