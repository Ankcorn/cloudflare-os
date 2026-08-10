// Runs against the real workerd tracing API (vitest-pool-workers), pinning the platform
// contract `traced` depends on: enterSpan ends its span when the returned promise settles, not
// when the synchronous callback returns (docs: workers/observability/traces/custom-spans/).
//
// Caveats:
// - Invocations are only traced when a tail consumer is attached, so vitest.config.ts wires a
//   no-op streaming tail sink behind the experimental `streaming_tail_worker` flag. If workerd
//   renames or removes that flag, setup fails loudly — a mechanical config fix, not a tracer bug.
// - Attributes are write-only, so "span still open" is inferred from the documented guarantee
//   that `span.isTraced` flips to false once the span ends. The entry assertion in each test
//   guards the signal itself: if invocations stop being traced, isTraced starts false and the
//   test fails rather than silently passing.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createPipelinedTracer, createTracer } from "../src/tracing";
import type { TraceSpan } from "../src/tracing";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const traced = createTracer(() => ({}));
const tracedPipelined = createPipelinedTracer(() => ({}));

type SpanRecorder = {
  getEvents(): Promise<string[]>;
  clear(): Promise<void>;
};
const probeEnv = env as unknown as { SPAN_RECORDER: SpanRecorder };

// Tail delivery is asynchronous; poll until the recorder's stream mentions `needle`.
async function recordedEventsMentioning(needle: string): Promise<string[]> {
  let events: string[] = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    events = await probeEnv.SPAN_RECORDER.getEvents();
    if (events.some((event) => event.includes(needle))) return events;
    await sleep(50);
  }
  throw new Error(`span recorder never streamed an event mentioning ${needle}; saw: ${
      JSON.stringify(events)}`);
}

describe("traced span lifetime", () => {
  it("keeps the span open across awaits in an async callback", async () => {
    const observed: boolean[] = [];
    await traced("probe", async (span) => {
      observed.push(span.isTraced); // must start true — guards the isTraced signal
      await sleep(50);
      observed.push(span.isTraced); // still true ⇒ span did not end at the sync return
    });
    expect(observed).toEqual([true, true]);
  });

  it("records the error attribute before the span can close on rejection", async () => {
    let openWhenErrorSet: boolean | undefined;
    await expect(
      traced("probe-reject", (span) => {
        // Shadow setAttribute to observe the instant traced()'s catch marks the failure.
        const original = span.setAttribute.bind(span);
        span.setAttribute = (key, value) => {
          if (key === "error") openWhenErrorSet = span.isTraced;
          original(key, value);
        };
        return (async () => {
          await sleep(50);
          throw new Error("boom");
        })();
      }),
    ).rejects.toThrow("boom");
    expect(openWhenErrorSet).toBe(true);
  });
});

describe("tracedPipelined", () => {
  it("returns the callback result by reference, never wrapped", async () => {
    const original = Promise.resolve(42);
    const result = tracedPipelined("probe-identity", () => original);
    expect(result).toBe(original);
    await result;
  });

  it("ends the span only when the promise settles", async () => {
    let captured: TraceSpan | undefined;
    let resolve!: (value: number) => void;
    const pending = new Promise<number>((r) => { resolve = r; });
    const result = tracedPipelined("probe-settle", (span) => {
      captured = span;
      return pending;
    });
    expect(result).toBe(pending);
    expect(captured!.isTraced).toBe(true); // still open after the sync return
    resolve(1);
    await pending;
    await sleep(0); // let the side observer run
    expect(captured!.isTraced).toBe(false); // ended once settled
  });

  it("records the error attribute before ending on rejection", async () => {
    let openWhenErrorSet: boolean | undefined;
    let captured: TraceSpan | undefined;
    const rejected = tracedPipelined("probe-pipelined-reject", (span) => {
      captured = span;
      const original = span.setAttribute.bind(span);
      span.setAttribute = (key, value) => {
        if (key === "error") openWhenErrorSet = span.isTraced;
        original(key, value);
      };
      return sleep(20).then(() => { throw new Error("boom"); });
    });
    await expect(rejected).rejects.toThrow("boom");
    await sleep(0);
    expect(openWhenErrorSet).toBe(true);
    expect(captured!.isTraced).toBe(false);
  });

  it("ends the span and rethrows when the callback throws synchronously", () => {
    let captured: TraceSpan | undefined;
    expect(() => tracedPipelined("probe-sync-throw", (span) => {
      captured = span;
      throw new Error("sync");
    })).toThrow("sync");
    expect(captured!.isTraced).toBe(false);
  });
});

// Pins that an unended span (a hung pipelined RPC) streams its spanOpen but loses its
// attributes, which flush only at spanClose. workshop-backend's loopback emits a
// separately-closed identity stamp because of this; if attributes start streaming eagerly,
// the stamp becomes redundant.
describe("unended span visibility in tail events", () => {
  it("streams the open event but not the attributes of a span that never ends", { timeout: 15_000 }, async () => {
    // Control: an ended span reaches the recorder with its attributes.
    tracedPipelined("pin-ended-span", (span) => {
      span.setAttribute("pinMarkerEnded", "yes");
      return Promise.resolve();
    });
    const controlEvents = await recordedEventsMentioning("pinMarkerEnded");
    expect(controlEvents.join("\n")).toContain("pin-ended-span");

    // Under test: attribute set at open, promise never settles, end() never runs.
    const never = new Promise(() => {});
    tracedPipelined("pin-unended-span", (span) => {
      span.setAttribute("pinMarkerUnended", "yes");
      return never;
    });

    // The open event (name) streams while the span is still open...
    await recordedEventsMentioning("pin-unended-span");
    // ...but its attribute never arrives (allow ample delivery time before asserting absence).
    await sleep(500);
    const events = await probeEnv.SPAN_RECORDER.getEvents();
    expect(events.join("\n")).not.toContain("pinMarkerUnended");
  });
});
