# Backend utilities

`@gadgets/backend-utils` is a shared library for code that runs in Cloudflare Workers. It is not a
standalone Worker and has no deployable entrypoint or Wrangler project configuration.

The package's Vitest configuration uses the Workers test pool to exercise runtime-specific APIs.
Consumers that import `@gadgets/backend-utils/observability-context` must enable `nodejs_als` (or
`nodejs_compat`); the default `@gadgets/backend-utils/logger` entry point has no such requirement.

An observability context exposes typed `.with()` and `.get()` methods, and creates loggers that
inherit its ambient fields.

The optional `@gadgets/backend-utils/error-reporting` entry point dispatches bounded error events to
a private Reporter bound as `ERROR_REPORTER`; `reportIssue(failureSite, caught, options?)` accepts
ambient fields under `options.attributes`, so callers can spread the context's `.get()` result and
augment it inline. Reporting is a no-op when the binding is absent.

The optional `@gadgets/backend-utils/trace-reporting` entry point mirrors that shape for spans:
`createSpanSink()` plugs into `createTracer(getContext, sink)` and batches sampled traces to a
private sink bound as `TRACE_SINK` (vendor-neutral `SpanV1` contract in `@gadgets/trace-reporting`).
Native Workers tracing is unaffected — the sink is a second destination for the same spans, sampled
per trace at the root (`TRACE_SINK_SAMPLE_RATE`, or `createSpanSink({ sampleRate })`). Inert when
the binding is absent; requires `nodejs_als` (or `nodejs_compat`) for trace-context propagation.
