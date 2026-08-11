// oxlint-disable-next-line typescript/triple-slash-reference -- Makes the focused ALS type available to source consumers.
/// <reference path="./node-async-hooks.d.ts" />

import { AsyncLocalStorage } from "node:async_hooks";
import { env, waitUntil, type WorkerEntrypoint } from "cloudflare:workers";
import { createLogger } from "./logger.js";
import type { SinkSpan, SpanSink } from "./tracing.js";
import {
  MAX_SPAN_ATTRIBUTE_KEYS,
  MAX_SPAN_STRING_CHARS,
  MAX_SPANS_PER_BATCH,
  type SpanV1,
  type TraceSinkProps,
} from "@gadgets/trace-reporting";

export {
  MAX_SPAN_ATTRIBUTE_KEYS,
  MAX_SPAN_STRING_CHARS,
  MAX_SPANS_PER_BATCH,
  type SpanAttributes,
  type SpanV1,
  type TraceSinkProps,
} from "@gadgets/trace-reporting";

/** Log fields owned by this module. */
type TraceReportingLogFields = { spanCount?: number };

const logger = createLogger<TraceReportingLogFields>({ component: "backend-utils.trace-reporting" });

/** Native Workers RPC capability implemented by the private trace-sink Worker. */
export interface TraceSink extends WorkerEntrypoint<unknown, TraceSinkProps> {
  reportSpans(spans: readonly SpanV1[]): Promise<void>;
}

declare global {
  namespace Cloudflare {
    interface Env {
      /** Optional private trace-sink service binding. */
      TRACE_SINK?: Service<TraceSink>;
      /** Root sampling rate in "0".."1"; read when `createSpanSink` gets no explicit rate. */
      TRACE_SINK_SAMPLE_RATE?: string;
    }
  }
}

export type SpanSinkOptions = Readonly<{
  /** Probability that a root span starts a reported trace; overrides TRACE_SINK_SAMPLE_RATE. */
  sampleRate?: number;
}>;

/** Sampling decision plus span identity, propagated to descendant spans within the isolate. */
type TraceContext =
  | Readonly<{ sampled: true; traceId: string; spanId: string }>
  | Readonly<{ sampled: false }>;

const NOT_SAMPLED: TraceContext = { sampled: false };

type OpenSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startEpochMs: number;
  attributes: Record<string, string | number | boolean>;
  attributeCount: number;
  truncated: boolean;
};

/**
 * Creates a `SpanSink` for `createTracer` that batches sampled spans to the optional private
 * `TRACE_SINK` binding. Inert when the binding is absent (local dev and deployments without a
 * trace destination) or when a trace's root span is not sampled; the root decision is made
 * once and inherited by every descendant span, so traces arrive whole or not at all.
 *
 * Like `reportIssue()`, dispatch reads the ambient `env`/`waitUntil` from `cloudflare:workers`
 * and must never disturb the traced caller: sink bookkeeping failures are swallowed (logged at
 * debug) while the callback's own result and exceptions always propagate unchanged.
 *
 * Batches flush when the root span settles and whenever MAX_SPANS_PER_BATCH spans accumulate
 * mid-trace. Spans finished outside any live invocation context may wait in the buffer until
 * the next flush; per-isolate buffering makes that loss-tolerant, never blocking.
 *
 * Trace context lives in AsyncLocalStorage (requires `nodejs_als` or `nodejs_compat`) and does
 * not cross RPC, hibernation, or restart — a downstream Worker starts its own trace.
 */
export function createSpanSink(options?: SpanSinkOptions): SpanSink {
  const storage = new AsyncLocalStorage<TraceContext>();
  let buffer: SpanV1[] = [];

  function flush(): void {
    if (buffer.length === 0 || env.TRACE_SINK === undefined) return;
    const spans = buffer;
    buffer = [];
    const dispatch = env.TRACE_SINK.reportSpans(spans);
    waitUntil(dispatch.catch((error) =>
      logger.debug("span batch dispatch failed",
        { event: "trace_report.dispatch.failed", spanCount: spans.length, error })));
  }

  function finish(open: OpenSpan): void {
    try {
      buffer.push(completeSpan(open, Date.now()));
      if (open.parentSpanId === undefined || buffer.length >= MAX_SPANS_PER_BATCH) flush();
    } catch (error) {
      logger.debug("span finish failed", { event: "trace_report.finish.failed", error });
    }
  }

  function enterSpan<Result>(name: string, run: (span: SinkSpan | undefined) => Result): Result {
    let context: TraceContext | undefined;
    let open: OpenSpan | undefined;
    try {
      if (env.TRACE_SINK !== undefined) {
        const parent = storage.getStore();
        if (parent === undefined) {
          context = sampleRoot(options) ? { sampled: true, ...newSpanIdentity() } : NOT_SAMPLED;
          if (context.sampled) open = openSpan(name, context.traceId, context.spanId);
        } else if (parent.sampled) {
          context = { sampled: true, traceId: parent.traceId, spanId: randomHex(8) };
          open = openSpan(name, context.traceId, context.spanId, parent.spanId);
        }
      }
    } catch (error) {
      // Sink setup must never disturb the traced caller; run the callback unrecorded.
      context = undefined;
      open = undefined;
      logger.debug("span setup failed", { event: "trace_report.setup.failed", error });
    }

    if (context === undefined) return run(undefined);
    const record = open;
    return storage.run(context, () => {
      if (record === undefined) return run(undefined);
      let settledSync = true;
      try {
        const result = run(spanHandle(record));
        if (result instanceof Promise) {
          settledSync = false;
          // Same new-promise caveat as `traced`'s error wrapper: don't wrap pipelined RPC
          // stubs. Chained after that wrapper, so the error attribute lands before finish.
          return result.finally(() => finish(record)) as Result;
        }
        return result;
      } finally {
        if (settledSync) finish(record);
      }
    });
  }

  return { enterSpan };
}

function sampleRoot(options?: SpanSinkOptions): boolean {
  const rate = options?.sampleRate ?? Number(env.TRACE_SINK_SAMPLE_RATE ?? "0");
  return rate > 0 && Math.random() < rate;
}

function newSpanIdentity(): { traceId: string; spanId: string } {
  return { traceId: randomHex(16), spanId: randomHex(8) };
}

function randomHex(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function openSpan(
    name: string, traceId: string, spanId: string, parentSpanId?: string): OpenSpan {
  const truncated = name.length > MAX_SPAN_STRING_CHARS;
  return {
    traceId,
    spanId,
    ...(parentSpanId !== undefined && { parentSpanId }),
    name: truncated ? name.slice(0, MAX_SPAN_STRING_CHARS) : name,
    startEpochMs: Date.now(),
    attributes: Object.create(null) as OpenSpan["attributes"],
    attributeCount: 0,
    truncated,
  };
}

function spanHandle(open: OpenSpan): SinkSpan {
  return {
    setAttribute(rawKey, value) {
      if (value === undefined) return;
      const mark = () => { open.truncated = true; };
      const key = boundString(rawKey, mark);
      if (!Object.hasOwn(open.attributes, key)) {
        if (open.attributeCount >= MAX_SPAN_ATTRIBUTE_KEYS) {
          mark();
          return;
        }
        open.attributeCount++;
      }
      open.attributes[key] = typeof value === "string" ? boundString(value, mark) : value;
    },
  };
}

function completeSpan(open: OpenSpan, endEpochMs: number): SpanV1 {
  return {
    schemaVersion: 1,
    traceId: open.traceId,
    spanId: open.spanId,
    ...(open.parentSpanId !== undefined && { parentSpanId: open.parentSpanId }),
    name: open.name,
    startEpochMs: open.startEpochMs,
    durationMs: Math.max(0, endEpochMs - open.startEpochMs),
    ...(open.attributeCount > 0 && { attributes: { ...open.attributes } }),
    ...(open.truncated && { truncated: true }),
  };
}

function boundString(value: string, mark: () => void): string {
  if (value.length <= MAX_SPAN_STRING_CHARS) return value;
  mark();
  return value.slice(0, MAX_SPAN_STRING_CHARS);
}
