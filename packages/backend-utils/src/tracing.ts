import { tracing } from "cloudflare:workers";

type Attribute = boolean | number | string;

// The span surface exposed to callbacks. Lifetime is managed by the tracer helpers, so no `end()`.
export interface TraceSpan {
  readonly isTraced: boolean;
  setAttribute(key: string, value?: Attribute): void;
}

function stampContext(span: Pick<TraceSpan, "setAttribute">,
    context: Readonly<Record<string, unknown>>) {
  for (const [key, value] of Object.entries(context)) {
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
      span.setAttribute(key, value);
    }
  }
}

/**
 * Creates a span helper that stamps the ambient observability context onto each span as
 * attributes. Tracing only: never logs, never modifies context. Exceptions propagate
 * unchanged, marked on the span via an `error` attribute (the beta API has no outcome).
 * Sync and async callbacks both get correct spans: enterSpan ends the span only when the
 * returned promise settles, not at the synchronous return (pinned by __tests__/tracing.test.ts).
 */
export function createTracer(getContext: () => Readonly<Record<string, unknown>>) {
  return function traced<Result>(name: string, callback: (span: TraceSpan) => Result): Result {
    return tracing.enterSpan(name, (span) => {
      if (span.isTraced) stampContext(span, getContext());
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
  };
}

/**
 * Like `createTracer`, but the helper returns the callback result unchanged, preserving RPC
 * promise/stub identity where `traced`'s `.catch` wrapper would collapse pipelining. A side
 * observer ends the span on settle (`error: true` on rejection).
 *
 * A promise that never settles streams only its spanOpen — attributes flush at close and are
 * lost (pinned by __tests__/tracing.test.ts) — so identity that must survive hangs needs a
 * separately-ended span alongside.
 */
export function createPipelinedTracer(getContext: () => Readonly<Record<string, unknown>>) {
  return function tracedPipelined<Result extends PromiseLike<unknown>>(
      name: string, callback: (span: TraceSpan) => Result): Result {
    return tracing.startActiveSpan(name, (span) => {
      if (span.isTraced) stampContext(span, getContext());
      try {
        const result = callback(span);
        if (!span.isTraced) {
          span.end();
          return result;
        }
        // Side observer only: `result` is returned as-is, never wrapped. The RPC return message
        // flows regardless; observing only materializes the result locally, off the critical path.
        void result.then(
            () => span.end(),
            () => {
              span.setAttribute("error", true);
              span.end();
            });
        return result;
      } catch (err) {
        span.setAttribute("error", true);
        span.end();
        throw err;
      }
    });
  };
}
