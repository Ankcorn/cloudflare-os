import createDOMPurify from "dompurify";

declare global {
  /** Sanitizes a complete HTML document inside Puppeteer's isolated realm. */
  var __workshopExportSanitizeHtml: (html: string) => string;
}

const purifier = createDOMPurify(window);
globalThis.__workshopExportSanitizeHtml = html => purifier.sanitize(html, {
  WHOLE_DOCUMENT: true,
}) as string;
