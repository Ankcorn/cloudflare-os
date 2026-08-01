import { describe, expect, it } from "vitest";
import {
  assertChatAttachmentSupportedByProvider,
  isAllowedChatAttachmentImageMimeType,
  validateChatAttachmentUpload,
} from "../src/chat-attachment-validation.js";

describe("assertChatAttachmentSupportedByProvider", () => {
  it("allows text and supported images without a selected model", () => {
    expect(() => assertChatAttachmentSupportedByProvider(undefined, "text/plain", 1)).not.toThrow();
    expect(() => assertChatAttachmentSupportedByProvider(undefined, "image/png", 1)).not.toThrow();
  });

  it("rejects pdfs without a selected model", () => {
    expect(() => assertChatAttachmentSupportedByProvider(undefined, "application/pdf", 1))
      .toThrow("Unsupported file type");
  });

  it("applies provider raw-file policy", () => {
    expect(() => assertChatAttachmentSupportedByProvider("anthropic", "text/plain", 1)).not.toThrow();
    expect(() => assertChatAttachmentSupportedByProvider("anthropic", "application/pdf", 1)).not.toThrow();
    expect(() => assertChatAttachmentSupportedByProvider("openai", "image/jpeg", 1)).not.toThrow();
    expect(() => assertChatAttachmentSupportedByProvider("openai", "application/pdf", 1)).not.toThrow();
    expect(() => assertChatAttachmentSupportedByProvider("google", "application/zip", 1)).not.toThrow();
    expect(() => assertChatAttachmentSupportedByProvider("cloudflare", "application/pdf", 1))
      .toThrow("Unsupported file type");
    expect(() => assertChatAttachmentSupportedByProvider("ollama", "application/zip", 1))
      .toThrow("Unsupported file type");
  });

  it("enforces the per-file byte limit", () => {
    expect(() => assertChatAttachmentSupportedByProvider(undefined, "text/plain", 1024 * 1024 + 1))
      .toThrow("Chat attachment is too large.");
  });
});

describe("validateChatAttachmentUpload", () => {
  it("normalizes MIME parameters before validation", () => {
    let attachment = validateChatAttachmentUpload({
      mimeType: "text/plain; charset=utf-8",
      content: new Uint8Array([1]),
      name: "notes.txt",
    });

    expect(attachment.mimeType).toBe("text/plain");
  });

  it.each([
    { label: "missing MIME type", mimeType: "", name: undefined },
    { label: "MIME type with a newline", mimeType: "text/plain\r\ninvalid", name: "notes.txt" },
    { label: "empty normalized MIME type", mimeType: ";", name: " \r\n " },
  ])("normalizes $label to octet-stream", ({ mimeType, name }) => {
    let attachment = validateChatAttachmentUpload({
      mimeType,
      content: new Uint8Array([1]),
      name,
    }, "google");

    expect(attachment.mimeType).toBe("application/octet-stream");
  });

  it("accepts matching JPEG content", () => {
    expect(() => validateChatAttachmentUpload({
      mimeType: "image/jpeg",
      content: new Uint8Array([0xff, 0xd8, 0xff]),
      name: "photo.jpg",
    })).not.toThrow();
  });

  it("accepts matching PNG and WebP content", () => {
    expect(() => validateChatAttachmentUpload({
      mimeType: "image/png",
      content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      name: "photo.png",
    })).not.toThrow();

    expect(() => validateChatAttachmentUpload({
      mimeType: "image/webp",
      content: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      name: "photo.webp",
    })).not.toThrow();
  });

  it("rejects image bytes that do not match their MIME", () => {
    expect(() => validateChatAttachmentUpload({
      mimeType: "image/jpeg",
      content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      name: "photo.jpg",
    })).toThrow("Chat image content does not match its MIME type.");
  });

  it("rejects WebP headers with a mismatch at every checked byte", () => {
    const validWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

    for (const index of [0, 1, 2, 3, 8, 9, 10, 11]) {
      const invalidWebp = validWebp.slice();
      invalidWebp[index] ^= 0xff;

      expect(() => validateChatAttachmentUpload({
        mimeType: "image/webp",
        content: invalidWebp,
        name: "photo.webp",
      })).toThrow("Chat image content does not match its MIME type.");
    }
  });

  it("identifies supported image MIME types", () => {
    expect(isAllowedChatAttachmentImageMimeType("image/png; charset=utf-8")).toBe(true);
    expect(isAllowedChatAttachmentImageMimeType(undefined)).toBe(false);
  });
});
