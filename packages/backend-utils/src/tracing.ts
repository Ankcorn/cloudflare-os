import { tracing } from "cloudflare:workers";

type Attribute = boolean | number | string;

// The span surface exposed to callbacks. Lifetime is managed by `traced`, so no `end()`.
export interface TraceSpan {
  readonly isTraced: boolean;
  setAttribute(key: string, value?: Attribute): void;
}

/** Producer-side handle for one open sink span; write-only, like the native surface. */
export interface SinkSpan {
  setAttribute(key: string, value?: Attribute): void;
}

/**
 * An optional secondary destination for completed spans (see trace-reporting.ts). The sink owns
 * the sampling decision and the span lifetime: `run` receives a handle when this span is
 * recorded and `undefined` otherwise, and the sink ends the span when `run`'s result settles.
 */
export interface SpanSink {
  enterSpan<Result>(name: string, run: (span: SinkSpan | undefined) => Result): Result;
}

/**
 * Creates a span helper that stamps the ambient observability context onto each span as
 * attributes. Tracing only: never logs, never modifies context. Exceptions propagate
 * unchanged, marked on the span via an `error` attribute (the beta API has no outcome).
 * Sync and async callbacks both get correct spans: enterSpan ends the span only when the
 * returned promise settles, not at the synchronous return (pinned by __tests__/tracing.test.ts).
 *
 * With a `sink`, each span is additionally offered to the sink so sampled traces reach the
 * optional external trace destination; attributes and the error marker are written to both.
 * Native Workers tracing is unaffected and continues to run for every invocation.
 */
export function createTracer(
    getContext: () => Readonly<Record<string, unknown>>, sink?: SpanSink) {
  function enterNativeSpan<Result>(
      name: string, callback: (span: TraceSpan) => Result, sinkSpan?: SinkSpan): Result {
    return tracing.enterSpan(name, (nativeSpan) => {
      const span = sinkSpan === undefined ? nativeSpan : combineSpans(nativeSpan, sinkSpan);
      if (span.isTraced) {
        for (const [key, value] of Object.entries(getContext())) {
          if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
            span.setAttribute(key, value);
          }
        }
      }
      // Boolean marker only: error text is unbounded and possibly sensitive, so it belongs to
      // logs/reporting, not trace attributes.
      const fail = () => span.setAttribute("error", true);
      try {
        const result = callback(span);
        // enterSpan keeps the span open until the returned promise settles, so async work gets
        // its real duration and fail() runs before the span can close (the runtime watches the
        // .catch-wrapped promise returned here). That wrapper is a new promise, not `result` —
        // fine for data results; don't wrap pipelined RPC stubs in `traced`.
        return result instanceof Promise
            ? result.catch((err) => { fail(); throw err; }) as Result
            : result;
      } catch (err) {
        fail();
        throw err;
      }
    });
  }

  return function traced<Result>(name: string, callback: (span: TraceSpan) => Result): Result {
    if (sink === undefined) return enterNativeSpan(name, callback);
    return sink.enterSpan(name, (sinkSpan) => enterNativeSpan(name, callback, sinkSpan));
  };
}

/**
 * Combines the native span with a sink span so attributes set after span creation land in
 * both. `isTraced` is unconditionally true: a sink span only exists when sampled, so callers
 * that gate attribute work on `isTraced` still feed the sink when native tracing is off.
 */
function combineSpans(nativeSpan: TraceSpan, sinkSpan: SinkSpan): TraceSpan {
  return {
    isTraced: true,
    setAttribute(key, value) {
      nativeSpan.setAttribute(key, value);
      sinkSpan.setAttribute(key, value);
    },
  };
}
