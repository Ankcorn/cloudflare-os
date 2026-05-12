import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  validateWebFetchUrl,
  webFetch,
  htmlToMarkdown,
  htmlToText,
} from "../src/web-fetch.js";

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

describe("htmlToMarkdown", () => {
  it("strips scripts and styles", () => {
    const md = htmlToMarkdown(
      `<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><p>Hi</p></body></html>`,
    );
    expect(md).not.toMatch(/alert/);
    expect(md).not.toMatch(/color:red/);
    expect(md).toMatch(/Hi/);
  });

  it("converts headings", () => {
    const md = htmlToMarkdown(`<h1>Title</h1><h2>Sub</h2><p>Text</p>`);
    expect(md).toMatch(/^# Title/);
    expect(md).toMatch(/## Sub/);
    expect(md).toMatch(/Text/);
  });

  it("converts links and images", () => {
    const md = htmlToMarkdown(
      `<a href="https://example.com">click</a> and <img src="https://example.com/x.png" alt="x">`,
    );
    expect(md).toContain("[click](https://example.com)");
    expect(md).toContain("![x](https://example.com/x.png)");
  });

  // Regression: a previous implementation read the wrong capture-group index for the
  // unquoted-src branch of the img regex, silently dropping such images. (Bare/unquoted
  // alt attributes are not supported; only the src branch is asserted here.)
  it("preserves images with bare (unquoted) src", () => {
    const md = htmlToMarkdown(`<img src=https://example.com/y.png alt="y">`);
    expect(md).toContain("![y](https://example.com/y.png)");
  });

  it("preserves bare-src even without alt", () => {
    const md = htmlToMarkdown(`<img src=https://example.com/z.png>`);
    expect(md).toContain("](https://example.com/z.png)");
  });

  it("converts lists", () => {
    const md = htmlToMarkdown(`<ul><li>one</li><li>two</li></ul>`);
    expect(md).toMatch(/- one/);
    expect(md).toMatch(/- two/);
  });

  it("converts code blocks and inline code", () => {
    const md = htmlToMarkdown(`<pre><code>a + b</code></pre>and <code>x</code>`);
    expect(md).toContain("```");
    expect(md).toContain("a + b");
    expect(md).toContain("`x`");
  });

  it("decodes common HTML entities", () => {
    const md = htmlToMarkdown(`<p>Tom &amp; Jerry &lt;3 &#39;hi&#39;</p>`);
    expect(md).toContain("Tom & Jerry <3 'hi'");
  });

  it("collapses excessive blank lines", () => {
    const md = htmlToMarkdown(`<p>a</p><p>b</p><p>c</p>`);
    expect(md).not.toMatch(/\n\n\n/);
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

    await expect(webFetch({ url: "https://example.com/" })).rejects.toThrow(
      /IP|blocked|Refusing/i,
    );
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

    await expect(webFetch({ url: "https://example.com/" })).rejects.toThrow();
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

    const result = await webFetch({ url: "https://example.com/" });
    expect(result.status).toBe(200);
    expect(result.body).toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("htmlToText", () => {
  it("strips all tags and returns text", () => {
    const t = htmlToText(`<h1>Title</h1><p>some <b>bold</b> text</p>`);
    expect(t).toContain("Title");
    expect(t).toContain("some bold text");
    expect(t).not.toMatch(/<[^>]+>/);
  });

  it("removes scripts and styles", () => {
    const t = htmlToText(
      `<style>p{color:red}</style><script>x()</script><p>kept</p>`,
    );
    expect(t).not.toMatch(/color:red/);
    expect(t).not.toMatch(/x\(\)/);
    expect(t).toContain("kept");
  });
});
