import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  validateWebFetchUrl,
  webFetch,
  type WebFetchEnv,
} from "../src/web-fetch.js";

// A minimal stand-in for the Workers AI binding's toMarkdown method. The real signature
// accepts a single document or an array of documents; we only use the single-document form
// in webFetch, so the stub mirrors only that branch.
type ToMarkdownStub = ReturnType<typeof vi.fn>;

function makeEnv(toMarkdown?: ToMarkdownStub): WebFetchEnv {
  const stub =
    toMarkdown ??
    vi.fn(async (doc: { name: string; blob: Blob }) => ({
      id: "stub-id",
      name: doc.name,
      mimeType: doc.blob.type,
      format: "markdown" as const,
      tokens: 0,
      data: `[converted from ${doc.blob.type}]`,
    }));

  // The Ai type has many methods we don't use; cast through unknown so we only need to
  // provide what webFetch actually touches.
  return {
    ai: { toMarkdown: stub } as unknown as Ai,
    gateway: null,
  };
}

describe("validateWebFetchUrl", () => {
  it("accepts ordinary public https URLs", () => {
    expect(() => validateWebFetchUrl("https://example.com/")).not.toThrow();
    expect(() =>
      validateWebFetchUrl("https://docs.example.com/path/to/page?x=1#frag"),
    ).not.toThrow();
  });

  it("rejects non-https schemes", () => {
    expect(() => validateWebFetchUrl("http://example.com/")).toThrow(/https/);
    expect(() => validateWebFetchUrl("ftp://example.com/")).toThrow();
    expect(() => validateWebFetchUrl("file:///etc/passwd")).toThrow();
    expect(() => validateWebFetchUrl("data:text/plain,hi")).toThrow();
    expect(() => validateWebFetchUrl("javascript:alert(1)")).toThrow();
  });

  it("rejects malformed URLs", () => {
    expect(() => validateWebFetchUrl("not a url")).toThrow(/Invalid URL/);
    expect(() => validateWebFetchUrl("")).toThrow(/Invalid URL/);
  });

  it("rejects URLs with embedded credentials", () => {
    expect(() => validateWebFetchUrl("https://user:pass@example.com/")).toThrow(
      /credentials/,
    );
  });

  it("rejects IPv4 literals", () => {
    expect(() => validateWebFetchUrl("https://127.0.0.1/")).toThrow(/IP/);
    expect(() => validateWebFetchUrl("https://10.0.0.1/")).toThrow(/IP/);
    expect(() => validateWebFetchUrl("https://169.254.169.254/")).toThrow(/IP/);
    expect(() => validateWebFetchUrl("https://8.8.8.8/")).toThrow(/IP/);
  });

  it("rejects IPv6 literals", () => {
    expect(() => validateWebFetchUrl("https://[::1]/")).toThrow(/IP/);
    expect(() => validateWebFetchUrl("https://[fe80::1]/")).toThrow(/IP/);
  });

  it("rejects local/internal hostnames", () => {
    expect(() => validateWebFetchUrl("https://localhost/")).toThrow();
    expect(() => validateWebFetchUrl("https://router.local/")).toThrow();
    expect(() => validateWebFetchUrl("https://service.internal/")).toThrow();
    expect(() => validateWebFetchUrl("https://machine.lan/")).toThrow();
    expect(() => validateWebFetchUrl("https://metadata.google.internal/")).toThrow();
  });

  it("rejects bare hostnames (no dot)", () => {
    expect(() => validateWebFetchUrl("https://internalhost/")).toThrow();
  });

  // Regression: trailing-dot hostnames are preserved by the WHATWG URL parser and DNS
  // resolvers treat them as equivalent FQDNs. Without trailing-dot normalization, every
  // entry in the block list could be trivially bypassed.
  it("rejects trailing-dot variants of blocked hostnames", () => {
    expect(() => validateWebFetchUrl("https://localhost./")).toThrow();
    expect(() =>
      validateWebFetchUrl("https://metadata.google.internal./"),
    ).toThrow();
    expect(() => validateWebFetchUrl("https://service.internal./")).toThrow();
    expect(() => validateWebFetchUrl("https://router.local./")).toThrow();
    expect(() => validateWebFetchUrl("https://x.lan./")).toThrow();
    // Multiple trailing dots should be stripped too.
    expect(() => validateWebFetchUrl("https://localhost.../")).toThrow();
  });

  it("normalization leaves legitimate hostnames alone", () => {
    expect(() => validateWebFetchUrl("https://example.com./")).not.toThrow();
  });
});

describe("webFetch redirect handling", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects a redirect that points at a blocked host", async () => {
    // Mock fetch: first call returns a 302 to 169.254.169.254 (AWS/GCP metadata-style).
    // followRedirects() must re-validate the Location and throw before issuing the next
    // fetch.
    const fetchMock = vi.fn(async (url: any) => {
      if (typeof url === "string" && url.startsWith("https://example.com")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://169.254.169.254/latest/meta-data/" },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(
      webFetch(makeEnv(), { url: "https://example.com/" }),
    ).rejects.toThrow(/IP|blocked|Refusing/i);
    // We should have made exactly one network call -- the redirect target must never have
    // been fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect that points at a trailing-dot blocked host", async () => {
    const fetchMock = vi.fn(async (url: any) => {
      if (typeof url === "string" && url.startsWith("https://example.com")) {
        return new Response(null, {
          status: 301,
          headers: { location: "https://metadata.google.internal./" },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    await expect(
      webFetch(makeEnv(), { url: "https://example.com/" }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect to another public host successfully", async () => {
    const fetchMock = vi.fn(async (url: any) => {
      if (url === "https://example.com/") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.org/landed" },
        });
      }
      if (url === "https://example.org/landed") {
        return new Response("hello", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const result = await webFetch(makeEnv(), { url: "https://example.com/" });
    expect(result.status).toBe(200);
    expect(result.body).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("webFetch document conversion", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockResponse(body: BodyInit, contentType: string, status = 200) {
    globalThis.fetch = vi.fn(async () =>
      new Response(body, {
        status,
        headers: { "content-type": contentType },
      }),
    ) as unknown as typeof globalThis.fetch;
  }

  it("hands HTML responses to env.AI.toMarkdown", async () => {
    mockResponse("<h1>Title</h1><p>Body</p>", "text/html; charset=utf-8");

    const toMarkdown = vi.fn(async (doc: { name: string; blob: Blob }) => ({
      id: "x",
      name: doc.name,
      mimeType: doc.blob.type,
      format: "markdown" as const,
      tokens: 5,
      data: "# Title\n\nBody",
    }));
    const env = makeEnv(toMarkdown);

    const result = await webFetch(env, { url: "https://example.com/page" });
    expect(toMarkdown).toHaveBeenCalledTimes(1);
    const [doc, options] = toMarkdown.mock.calls[0];
    expect(doc.blob.type).toBe("text/html");
    expect(options.conversionOptions.html.hostname).toBe("https://example.com");
    expect(options.conversionOptions.html.images.convert).toBe(false);
    expect(result.body).toBe("# Title\n\nBody");
  });

  it("hands PDF responses to env.AI.toMarkdown", async () => {
    // PDFs are binary; the actual bytes don't matter for the test since toMarkdown is
    // stubbed.
    mockResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf");

    const toMarkdown = vi.fn(async (doc: { name: string; blob: Blob }) => ({
      id: "x",
      name: doc.name,
      mimeType: doc.blob.type,
      format: "markdown" as const,
      tokens: 1,
      data: "PDF text content",
    }));
    const env = makeEnv(toMarkdown);

    const result = await webFetch(env, { url: "https://example.com/doc.pdf" });
    expect(toMarkdown).toHaveBeenCalledTimes(1);
    expect(toMarkdown.mock.calls[0][0].blob.type).toBe("application/pdf");
    expect(result.body).toBe("PDF text content");
  });

  it("passes plain text through unconverted", async () => {
    mockResponse("just some text", "text/plain");

    const toMarkdown = vi.fn();
    const env = makeEnv(toMarkdown as unknown as ToMarkdownStub);

    const result = await webFetch(env, { url: "https://example.com/file.txt" });
    expect(toMarkdown).not.toHaveBeenCalled();
    expect(result.body).toBe("just some text");
  });

  it("passes JSON through unconverted", async () => {
    mockResponse('{"a":1}', "application/json");
    const toMarkdown = vi.fn();
    const env = makeEnv(toMarkdown as unknown as ToMarkdownStub);

    const result = await webFetch(env, { url: "https://example.com/api" });
    expect(toMarkdown).not.toHaveBeenCalled();
    expect(result.body).toBe('{"a":1}');
  });

  it("returns raw body when accept=html, skipping toMarkdown even for HTML", async () => {
    mockResponse("<h1>Raw</h1>", "text/html");
    const toMarkdown = vi.fn();
    const env = makeEnv(toMarkdown as unknown as ToMarkdownStub);

    const result = await webFetch(env, {
      url: "https://example.com/",
      accept: "html",
    });
    expect(toMarkdown).not.toHaveBeenCalled();
    expect(result.body).toBe("<h1>Raw</h1>");
  });

  it("surfaces a contextual error when toMarkdown returns format='error'", async () => {
    mockResponse("<html>broken</html>", "text/html");

    const toMarkdown = vi.fn(async (doc: { name: string; blob: Blob }) => ({
      id: "x",
      name: doc.name,
      mimeType: doc.blob.type,
      format: "error" as const,
      error: "parser blew up",
    }));
    const env = makeEnv(toMarkdown);

    await expect(
      webFetch(env, { url: "https://example.com/" }),
    ).rejects.toThrow(/parser blew up/);
  });

  it("strips parameters from Content-Type before matching the conversion allow-list", async () => {
    // Same as the HTML test but with a charset suffix; behavior should be identical.
    mockResponse("<p>hi</p>", "text/html; charset=us-ascii");

    const toMarkdown = vi.fn(async (doc: { name: string; blob: Blob }) => ({
      id: "x",
      name: doc.name,
      mimeType: doc.blob.type,
      format: "markdown" as const,
      tokens: 0,
      data: "hi",
    }));
    const env = makeEnv(toMarkdown);

    await webFetch(env, { url: "https://example.com/" });
    expect(toMarkdown).toHaveBeenCalledTimes(1);
  });

  it("does NOT call toMarkdown for image MIME types (cost guardrail)", async () => {
    // Image conversion uses paid Workers AI models. We explicitly exclude images from the
    // allow-list so a webFetch call can never trigger that path.
    mockResponse(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg");

    const toMarkdown = vi.fn();
    const env = makeEnv(toMarkdown as unknown as ToMarkdownStub);

    const result = await webFetch(env, { url: "https://example.com/x.jpg" });
    expect(toMarkdown).not.toHaveBeenCalled();
    // Body is decoded as UTF-8 (with replacement chars for invalid sequences); the test
    // only cares that the call didn't go through toMarkdown.
    expect(typeof result.body).toBe("string");
  });
});
