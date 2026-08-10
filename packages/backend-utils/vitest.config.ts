import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-02-02",
        // nodejs_als enables observability context; experimental enables the Reporter stub below
        // and the streaming_tail_worker flag (which workerd refuses without experimental mode).
        compatibilityFlags: ["experimental", "nodejs_als", "streaming_tail_worker"],
        serviceBindings: {
          ERROR_REPORTER: { name: "reporter", entrypoint: "ErrorReporter" },
          SPAN_RECORDER: { name: "span-recorder", entrypoint: "SpanRecorder" },
        },
        // Invocations are only traced (span.isTraced === true) when a tail consumer is attached;
        // the no-op "span-sink" below exists solely so tracing.test.ts can observe span lifetime.
        tails: ["span-sink"],
        // Span events flow only to streamingTails consumers (`tails` is the legacy path); the
        // recorder captures them for tracing.test.ts.
        streamingTails: ["span-recorder"],
        workers: [{
          name: "span-sink",
          modules: true,
          compatibilityDate: "2026-02-02",
          compatibilityFlags: ["streaming_tail_worker"],
          // The no-op tail() silences workerd's legacy tail delivery, which it attempts alongside
          // the streaming path.
          script: `export default { tail: () => {}, tailStream: () => () => {} }`,
        }, {
          // Records every tail-stream event as JSON strings queryable over RPC. Streaming
          // delivery is incremental, so tests can observe their own invocation's spans mid-flight.
          name: "span-recorder",
          modules: true,
          compatibilityDate: "2026-02-02",
          compatibilityFlags: ["experimental", "streaming_tail_worker"],
          script: `
            import { WorkerEntrypoint } from "cloudflare:workers";
            let events = [];
            const record = (ev) => {
              try {
                events.push(JSON.stringify(ev));
              } catch (err) {
                events.push("unserializable: " + String(err));
              }
            };
            export default {
              // The no-op tail() silences workerd's legacy tail delivery (see span-sink above).
              tail: () => {},
              tailStream(event) {
                record(event);
                return record;
              },
            };
            export class SpanRecorder extends WorkerEntrypoint {
              async getEvents() { return events; }
              async clear() { events = []; }
            }
          `,
        }, {
          name: "reporter",
          modules: true,
          script: `
            import { WorkerEntrypoint } from "cloudflare:workers";
            let lastEvent;
            export class ErrorReporter extends WorkerEntrypoint {
              async report(event) {
                // The "reporter-failure" site simulates a down reporter so the caller's
                // isolation can be tested. workerd logs this guest throw server-side
                // ("Error: reporter down" attributed to ErrorReporter.report) — that line is
                // expected test output, not a failure in reportIssue.
                if (event.failureSite === "reporter-failure") {
                  throw new Error("reporter down");
                }
                lastEvent = event;
              }
              async clear() { lastEvent = undefined; }
              async getLast() { return lastEvent; }
            }
          `,
        }],
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
  },
});
