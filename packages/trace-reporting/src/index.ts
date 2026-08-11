/** Maximum retained scalar attributes on one span. */
export const MAX_SPAN_ATTRIBUTE_KEYS = 32;
/** Maximum retained length for span names, attribute keys, and string attribute values. */
export const MAX_SPAN_STRING_CHARS = 256;
/** Maximum spans per `reportSpans()` batch; producers flush before exceeding it. */
export const MAX_SPANS_PER_BATCH = 64;

/** Bounded scalar span attributes. An `error: true` attribute marks a failed span. */
export type SpanAttributes = Readonly<Record<string, string | number | boolean>>;

/**
 * A bounded, vendor-neutral completed span sent to an internal trace sink. Identifiers use the
 * W3C trace-context format so a sink can bridge to any tracing backend without translation.
 */
export type SpanV1 = Readonly<{
  schemaVersion: 1;
  /** 32 lowercase-hex chars (W3C trace-id); never all zeros. */
  traceId: string;
  /** 16 lowercase-hex chars (W3C parent-id); never all zeros. */
  spanId: string;
  /** Absent on a trace's root span. */
  parentSpanId?: string;
  name: string;
  startEpochMs: number;
  durationMs: number;
  attributes?: SpanAttributes;
  truncated?: true;
}>;

/** Trusted producer metadata configured on each trace-sink service binding. */
export type TraceSinkProps = Readonly<{
  service: string;
  release?: string;
  environment?: string;
}>;

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue(object: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(object, key)?.value;
}

function validTraceId(value: unknown): value is string {
  return typeof value === "string" && TRACE_ID_PATTERN.test(value) && value !== ZERO_TRACE_ID;
}

function validSpanId(value: unknown): value is string {
  return typeof value === "string" && SPAN_ID_PATTERN.test(value) && value !== ZERO_SPAN_ID;
}

function boundedString(value: string, mark: () => void): string {
  if (value.length <= MAX_SPAN_STRING_CHARS) return value;
  mark();
  return value.slice(0, MAX_SPAN_STRING_CHARS);
}

function normalizeAttributes(
    value: unknown, mark: () => void): SpanAttributes | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    mark();
    return undefined;
  }
  const output = Object.create(null) as Record<string, string | number | boolean>;
  let count = 0;
  for (const rawKey of Object.getOwnPropertyNames(value)) {
    if (count >= MAX_SPAN_ATTRIBUTE_KEYS) {
      mark();
      break;
    }
    const attribute = ownValue(value, rawKey);
    if (typeof attribute !== "string"
        && typeof attribute !== "number"
        && typeof attribute !== "boolean") {
      mark();
      continue;
    }
    const key = boundedString(rawKey, mark);
    if (Object.hasOwn(output, key)) {
      mark();
      continue;
    }
    output[key] = typeof attribute === "string" ? boundedString(attribute, mark) : attribute;
    count++;
  }
  return count ? { ...output } : undefined;
}

/**
 * Normalizes one untrusted span into a fresh, bounded allowlisted object. Identity and timing
 * are strict — an invalid id or non-finite time rejects the span — while names and attributes
 * are tolerated and bounded, mirroring `normalizeFrontendErrorReport`'s posture.
 */
export function normalizeSpan(input: unknown): SpanV1 | null {
  try {
    if (!isRecord(input) || ownValue(input, "schemaVersion") !== 1) return null;
    const traceId = ownValue(input, "traceId");
    const spanId = ownValue(input, "spanId");
    const parentSpanId = ownValue(input, "parentSpanId");
    const name = ownValue(input, "name");
    const startEpochMs = ownValue(input, "startEpochMs");
    const durationMs = ownValue(input, "durationMs");
    if (!validTraceId(traceId) || !validSpanId(spanId)) return null;
    if (parentSpanId !== undefined && (!validSpanId(parentSpanId) || parentSpanId === spanId)) {
      return null;
    }
    if (typeof name !== "string" || name.length === 0) return null;
    if (typeof startEpochMs !== "number" || !Number.isFinite(startEpochMs) || startEpochMs <= 0) {
      return null;
    }
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
      return null;
    }

    let truncated = ownValue(input, "truncated") === true;
    const mark = () => { truncated = true; };
    const attributes = normalizeAttributes(ownValue(input, "attributes"), mark);
    return {
      schemaVersion: 1,
      traceId,
      spanId,
      ...(parentSpanId !== undefined && { parentSpanId }),
      name: boundedString(name, mark),
      startEpochMs,
      durationMs,
      ...(attributes && { attributes }),
      ...(truncated && { truncated: true }),
    };
  } catch {
    return null;
  }
}

/** Normalizes an untrusted batch, dropping invalid spans and bounding the batch size. */
export function normalizeSpanBatch(input: unknown): SpanV1[] {
  try {
    if (!Array.isArray(input)) return [];
    return input.slice(0, MAX_SPANS_PER_BATCH)
      .map(normalizeSpan)
      .filter((span): span is SpanV1 => span !== null);
  } catch {
    return [];
  }
}
