import { describe, expect, it } from "vitest";
import {
  MAX_SPAN_ATTRIBUTE_KEYS,
  MAX_SPAN_STRING_CHARS,
  MAX_SPANS_PER_BATCH,
  normalizeSpan,
  normalizeSpanBatch,
} from "./index.js";

const span = {
  schemaVersion: 1,
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  parentSpanId: "00f067aa0ba902b7",
  name: "overseer.run-agent",
  startEpochMs: 1_754_900_000_000,
  durationMs: 12.5,
  attributes: { accountId: 7, outcome: "ok", retried: false },
} as const;

describe("normalizeSpan", () => {
  it("passes a complete valid span through as a fresh object", () => {
    const normalized = normalizeSpan(span);
    expect(normalized).toEqual(span);
    expect(normalized).not.toBe(span);
    expect(Object.getPrototypeOf(normalized?.attributes)).toBe(Object.prototype);
  });

  it("accepts a root span without a parent", () => {
    const { parentSpanId: _dropped, ...root } = span;
    expect(normalizeSpan(root)).toEqual(root);
  });

  it("rejects invalid identity and timing outright", () => {
    const rejected: unknown[] = [
      null,
      "span",
      { ...span, schemaVersion: 2 },
      { ...span, traceId: span.traceId.toUpperCase() },
      { ...span, traceId: "0".repeat(32) },
      { ...span, traceId: span.traceId.slice(1) },
      { ...span, spanId: "0".repeat(16) },
      { ...span, parentSpanId: span.spanId },
      { ...span, parentSpanId: "not-hex" },
      { ...span, name: "" },
      { ...span, startEpochMs: 0 },
      { ...span, startEpochMs: Number.NaN },
      { ...span, durationMs: -1 },
      { ...span, durationMs: Number.POSITIVE_INFINITY },
    ];
    for (const input of rejected) expect(normalizeSpan(input)).toBeNull();
  });

  it("bounds names and attributes instead of rejecting them", () => {
    const attributes: Record<string, unknown> = { nested: { secret: "do not traverse" } };
    Object.defineProperty(attributes, "getter", {
      get() { throw new Error("getter invoked"); },
      enumerable: true,
    });
    for (let i = 0; i < MAX_SPAN_ATTRIBUTE_KEYS + 1; i++) {
      attributes[`k${i}`] = "v".repeat(MAX_SPAN_STRING_CHARS + 1);
    }

    const normalized = normalizeSpan({
      ...span,
      name: "n".repeat(MAX_SPAN_STRING_CHARS + 1),
      attributes,
    });

    expect(normalized?.name).toHaveLength(MAX_SPAN_STRING_CHARS);
    expect(Object.keys(normalized?.attributes ?? {})).toHaveLength(MAX_SPAN_ATTRIBUTE_KEYS);
    expect(normalized?.attributes?.k0).toHaveLength(MAX_SPAN_STRING_CHARS);
    expect(normalized?.attributes).not.toHaveProperty("nested");
    expect(normalized?.truncated).toBe(true);
  });

  it("preserves a producer-set truncated marker", () => {
    expect(normalizeSpan({ ...span, truncated: true })?.truncated).toBe(true);
  });
});

describe("normalizeSpanBatch", () => {
  it("drops invalid entries and bounds the batch size", () => {
    const oversized = Array.from(
      { length: MAX_SPANS_PER_BATCH + 8 },
      (_, index) => (index === 1 ? { garbage: true } : span),
    );
    const batch = normalizeSpanBatch(oversized);
    expect(batch).toHaveLength(MAX_SPANS_PER_BATCH - 1);
    expect(batch[0]).toEqual(span);
  });

  it("returns an empty batch for non-arrays", () => {
    expect(normalizeSpanBatch({ spans: [span] })).toEqual([]);
    expect(normalizeSpanBatch(undefined)).toEqual([]);
  });
});
