import { describe, it, expect } from "vitest";
import {
  validateWebFetchUrl,
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
