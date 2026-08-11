import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSpanSink,
  MAX_SPAN_ATTRIBUTE_KEYS,
  MAX_SPANS_PER_BATCH,
  type SpanV1,
} from "../src/trace-reporting.js";
import { createTracer } from "../src/tracing.js";

type TestSink = NonNullable<typeof env.TRACE_SINK> & {
  clear(): Promise<void>;
  getBatches(): Promise<SpanV1[][]>;
};

const sink = env.TRACE_SINK as TestSink;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;

describe("createSpanSink", () => {
  beforeEach(() => sink.clear());
  afterEach(() => vi.restoreAllMocks());

  it("reports one whole trace when the sampled root span settles", async () => {
    const traced = createTracer(() => ({ accountId: 7 }), createSpanSink({ sampleRate: 1 }));

    const returned = await traced("root", async (span) => {
      span.setAttribute("operation", "test.run");
      await traced("child", async () => { await sleep(50); });
      return "value";
    });
    expect(returned).toBe("value");

    const batches = await vi.waitFor(async () => {
      const all = await sink.getBatches();
      expect(all).toHaveLength(1);
      return all;
    });
    const spans = batches[0]!;
    expect(spans.map((span) => span.name)).toEqual(["child", "root"]);

    const [child, root] = spans as [SpanV1, SpanV1];
    expect(root.traceId).toMatch(TRACE_ID_PATTERN);
    expect(root.spanId).toMatch(SPAN_ID_PATTERN);
    expect(root.parentSpanId).toBeUndefined();
    expect(child.traceId).toBe(root.traceId);
    expect(child.parentSpanId).toBe(root.spanId);
    expect(child.spanId).not.toBe(root.spanId);
    // Both spans carry the ambient context; the root also has its explicit attribute.
    expect(root.attributes).toMatchObject({ accountId: 7, operation: "test.run" });
    expect(child.attributes).toMatchObject({ accountId: 7 });
    // The workerd clock advances on I/O, so the awaited sleep is visible in both durations.
    expect(child.durationMs).toBeGreaterThanOrEqual(40);
    expect(root.durationMs).toBeGreaterThanOrEqual(child.durationMs);
    expect(root.startEpochMs).toBeLessThanOrEqual(child.startEpochMs);
    for (const span of spans) expect(span.schemaVersion).toBe(1);
  });

  it("marks a failed span with the error attribute before flushing", async () => {
    const traced = createTracer(() => ({}), createSpanSink({ sampleRate: 1 }));

    await expect(traced("root", async () => {
      await sleep(10);
      throw new Error("boom");
    })).rejects.toThrow("boom");

    const batches = await vi.waitFor(async () => {
      const all = await sink.getBatches();
      expect(all).toHaveLength(1);
      return all;
    });
    expect(batches[0]).toHaveLength(1);
    expect(batches[0]![0]).toMatchObject({ name: "root", attributes: { error: true } });
  });

  it("flushes a full batch mid-trace and the remainder at root completion", async () => {
    const traced = createTracer(() => ({}), createSpanSink({ sampleRate: 1 }));

    await traced("root", async () => {
      for (let i = 0; i < MAX_SPANS_PER_BATCH; i++) traced(`child-${i}`, () => {});
      await sleep(10);
    });

    const batches = await vi.waitFor(async () => {
      const all = await sink.getBatches();
      expect(all).toHaveLength(2);
      return all;
    });
    expect(batches[0]).toHaveLength(MAX_SPANS_PER_BATCH);
    expect(batches[1]!.map((span) => span.name)).toEqual(["root"]);
  });

  it("bounds span attributes and marks truncation", async () => {
    const traced = createTracer(() => ({}), createSpanSink({ sampleRate: 1 }));

    traced("root", (span) => {
      for (let i = 0; i < MAX_SPAN_ATTRIBUTE_KEYS + 1; i++) span.setAttribute(`k${i}`, i);
      span.setAttribute("k0", "overwritten"); // overwrite: not a new key, always retained
      span.setAttribute("skipped", undefined);
    });

    const batches = await vi.waitFor(async () => {
      const all = await sink.getBatches();
      expect(all).toHaveLength(1);
      return all;
    });
    const [span] = batches[0] as [SpanV1];
    expect(Object.keys(span.attributes ?? {})).toHaveLength(MAX_SPAN_ATTRIBUTE_KEYS);
    expect(span.attributes).toMatchObject({ k0: "overwritten" });
    expect(span.attributes).not.toHaveProperty("skipped");
    expect(span.truncated).toBe(true);
  });

  it("samples out whole traces, descendants included", async () => {
    const traced = createTracer(() => ({}), createSpanSink({ sampleRate: 0 }));

    await traced("root", async () => {
      traced("child", () => {});
      await sleep(10);
    });

    await sleep(20); // give any (unexpected) dispatch time to land
    expect(await sink.getBatches()).toEqual([]);
  });

  it("reads TRACE_SINK_SAMPLE_RATE when no explicit rate is given", async () => {
    env.TRACE_SINK_SAMPLE_RATE = "1";
    try {
      const traced = createTracer(() => ({}), createSpanSink());
      traced("root", () => {});
      await vi.waitFor(async () => expect(await sink.getBatches()).toHaveLength(1));
    } finally {
      delete env.TRACE_SINK_SAMPLE_RATE;
    }
  });

  it("is inert without the TRACE_SINK binding and never disturbs the caller", () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const saved = env.TRACE_SINK;
    delete env.TRACE_SINK;
    try {
      const traced = createTracer(() => ({}), createSpanSink({ sampleRate: 1 }));
      expect(traced("root", () => "value")).toBe("value");
      expect(debugSpy).not.toHaveBeenCalled();
    } finally {
      env.TRACE_SINK = saved;
    }
  });

  it("isolates the caller from a rejecting sink and logs the drop", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const traced = createTracer(() => ({}), createSpanSink({ sampleRate: 1 }));

    expect(traced("sink-failure", () => "value")).toBe("value");

    await vi.waitFor(() => expect(debugSpy).toHaveBeenCalled());
    expect(debugSpy.mock.calls.map(([entry]) => entry?.event))
      .toContain("trace_report.dispatch.failed");
  });
});
