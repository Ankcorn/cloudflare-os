import { env, waitUntil, type WorkerEntrypoint } from "cloudflare:workers";
import { createLogger } from "./logger.js";

/** Log fields owned by this module. */
type ErrorReportingLogFields = { failureSite?: string };

const logger = createLogger<ErrorReportingLogFields>({ component: "backend-utils.error-reporting" });

/** Max retained length of an exception message. */
export const MAX_MESSAGE_CHARS = 1024;
/** Max retained length of an exception stack. */
export const MAX_STACK_CHARS = 16_384;
/** Max number of retained scalar attributes. */
export const MAX_ATTRIBUTE_KEYS = 32;
/** Max retained length of any other bounded string (site, type, keys, correlation, http). */
export const MAX_STRING_CHARS = 256;

/** A bounded, vendor-neutral error occurrence sent to the private Reporter. */
export type ErrorEventV1 = Readonly<{
  schemaVersion: 1;
  occurrenceId: string;
  occurredAt: string;
  /** Stable literal identifying the capture site. */
  failureSite: string;
  severity: "warning" | "error" | "fatal";
  /** Whether the producer recovered instead of failing the operation. */
  handled: boolean;
  exception?: Readonly<{
    type: string;
    message?: string;
    stack?: string;
    truncated?: true;
  }>;
  correlation?: Readonly<{ rayId?: string; requestId?: string }>;
  http?: Readonly<{
    kind: "server" | "client";
    method?: string;
    routeTemplate?: string;
    responseStatusCode?: number;
  }>;
  /** Bounded scalars only; no raw runtime objects or nested context. */
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
  truncated?: true;
}>;

/** Trusted producer metadata configured on each Reporter service binding. */
export type ErrorReporterProps = Readonly<{
  service: string;
  release?: string;
  environment?: string;
}>;

/** Optional details already available at the capture site. */
export type ErrorReportOptions = Readonly<{
  handled?: boolean;
  severity?: ErrorEventV1["severity"];
  correlation?: ErrorEventV1["correlation"];
  http?: ErrorEventV1["http"];
  /**
   * Arbitrary observability context to record as attributes. Only bounded scalars are retained;
   * non-scalars are dropped.
   */
  attributes?: Readonly<Record<string, unknown>>;
}>;

/** Native Workers RPC capability implemented by the private Reporter Worker. */
export interface ErrorReporter extends WorkerEntrypoint<unknown, ErrorReporterProps> {
  report(event: ErrorEventV1): Promise<void>;
}

declare global {
  namespace Cloudflare {
    interface Env {
      /** Optional private error Reporter service binding. */
      ERROR_REPORTER?: Service<ErrorReporter>;
    }
  }
}

type Exception = NonNullable<ErrorEventV1["exception"]>;
type Scalar = string | number | boolean | null;

/** Builds a bounded error event without traversing arbitrary thrown objects. */
function createErrorEvent(
    failureSite: string, caught: unknown, options?: ErrorReportOptions): ErrorEventV1 {
  let truncated = false;
  const mark = () => { truncated = true; };
  const exception = normalizeException(caught, mark);
  const correlation = normalizeCorrelation(options?.correlation, mark);
  const http = normalizeHttp(options?.http, mark);
  const attributes = normalizeAttributes(options?.attributes, mark);

  return {
    schemaVersion: 1,
    occurrenceId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    failureSite: boundString(failureSite, MAX_STRING_CHARS, mark),
    severity: options?.severity ?? "error",
    handled: options?.handled ?? false,
    exception,
    ...(correlation && { correlation }),
    ...(http && { http }),
    ...(attributes && { attributes }),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Reports an exception to the private Reporter without allowing reporting failures to affect
 * the caller. A no-op when the optional `ERROR_REPORTER` binding is absent (local dev and
 * deployments without an Issue destination).
 *
 * Unlike recordAnalytics() (which threads ctx/env through every call site), this reads the
 * ambient `env` and `waitUntil` from `cloudflare:workers` so a single line reports from any
 * Worker, DO method, or alarm without plumbing arguments to each capture site.
 *
 * Lifetime: `report()` is dispatched eagerly, so the outbound RPC is in flight before
 * `waitUntil` is consulted. In a stateless Worker `waitUntil` extends the event past the
 * response so the RPC can finish. In a Durable Object `waitUntil` has no effect, but the
 * in-flight RPC is pending I/O that keeps the object alive until it settles. Delivery holds
 * in both contexts; failures are logged at debug rather than swallowed silently.
 *
 * `attributes` records ambient context; spread an observability context's `get()` result and
 * augment it inline when the capture site has additional fields.
 */
export function reportIssue(
    failureSite: string,
    caught: unknown,
    options?: ErrorReportOptions): void {
  try {
    if (!env.ERROR_REPORTER) return;
    const event = createErrorEvent(failureSite, caught, options);
    const dispatch = env.ERROR_REPORTER.report(event);
    waitUntil(dispatch.catch((error) =>
      logger.debug("error report dispatch failed",
        { event: "error_report.dispatch.failed", failureSite, error })));
  } catch (error) {
    // Reporting must never disturb the caller; record the setup failure and move on.
    logger.debug("error report setup failed",
      { event: "error_report.setup.failed", failureSite, error });
  }
}

function normalizeException(caught: unknown, mark: () => void): Exception {
  try {
    if (caught === null) return { type: "NullThrown" };
    if (typeof caught === "function") return { type: "FunctionThrown" };
    if (typeof caught !== "object") {
      return makeException(`${typeof caught}Thrown`, String(caught), undefined, mark);
    }
    if (caught instanceof Error) {
      // Read genuine Errors directly: `Error.stack` is a native accessor, so the
      // getter-avoiding readString() below cannot see it. Any custom getter that
      // throws is caught by the outer try/catch and reported as uninspectable.
      const { name, message, stack } = caught;
      return makeException(
        typeof name === "string" ? name : "Error",
        typeof message === "string" ? message : undefined,
        typeof stack === "string" ? stack : undefined,
        mark,
      );
    }
    return makeException(
      readString(caught, "name") ?? "Object",
      readString(caught, "message"),
      readString(caught, "stack"),
      mark,
    );
  } catch {
    mark();
    return { type: "UninspectableThrown", truncated: true };
  }
}

function makeException(
    type: string,
    message: string | undefined,
    stack: string | undefined,
    mark: () => void): Exception {
  const truncated = type.length > MAX_STRING_CHARS
    || (message?.length ?? 0) > MAX_MESSAGE_CHARS
    || (stack?.length ?? 0) > MAX_STACK_CHARS;
  const result = {
    type: boundString(type, MAX_STRING_CHARS, mark),
    ...(message !== undefined && { message: boundString(message, MAX_MESSAGE_CHARS, mark) }),
    ...(stack !== undefined && { stack: boundString(stack, MAX_STACK_CHARS, mark) }),
  };
  return truncated ? { ...result, truncated: true } : result;
}

function readString(object: object, key: string): string | undefined {
  const value = Object.getOwnPropertyDescriptor(object, key)?.value;
  return typeof value === "string" ? value : undefined;
}

function normalizeCorrelation(
    correlation: ErrorReportOptions["correlation"],
    mark: () => void): ErrorEventV1["correlation"] | undefined {
  if (!correlation) return undefined;
  const rayId = boundOptionalString(correlation.rayId, mark);
  const requestId = boundOptionalString(correlation.requestId, mark);
  if (rayId === undefined && requestId === undefined) return undefined;
  return {
    ...(rayId !== undefined && { rayId }),
    ...(requestId !== undefined && { requestId }),
  };
}

function normalizeHttp(
    http: ErrorReportOptions["http"],
    mark: () => void): ErrorEventV1["http"] | undefined {
  if (!http) return undefined;
  const method = boundOptionalString(http.method, mark);
  const routeTemplate = boundOptionalString(http.routeTemplate, mark);
  return {
    // Normalize to the two literals; callers cross a JS trust boundary where the union
    // isn't enforced at runtime, so never pass an arbitrary string through.
    kind: http.kind === "server" ? "server" : "client",
    ...(method !== undefined && { method }),
    ...(routeTemplate !== undefined && { routeTemplate }),
    ...(Number.isFinite(http.responseStatusCode) && {
      responseStatusCode: http.responseStatusCode,
    }),
  };
}

function normalizeAttributes(
    attributes: ErrorReportOptions["attributes"],
    mark: () => void): ErrorEventV1["attributes"] | undefined {
  if (!attributes) return undefined;
  const output = Object.create(null) as Record<string, Scalar>;
  let count = 0;
  for (const rawKey of Object.getOwnPropertyNames(attributes)) {
    if (count >= MAX_ATTRIBUTE_KEYS) {
      mark();
      break;
    }
    const value = Object.getOwnPropertyDescriptor(attributes, rawKey)?.value;
    if (!isScalar(value)) {
      mark();
      continue;
    }
    const key = boundString(rawKey, MAX_STRING_CHARS, mark);
    if (Object.hasOwn(output, key)) {
      mark();
      continue;
    }
    output[key] = typeof value === "string"
      ? boundString(value, MAX_STRING_CHARS, mark)
      : value;
    count++;
  }
  return count ? { ...output } : undefined;
}

function isScalar(value: unknown): value is Scalar {
  return value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean";
}

function boundOptionalString(value: string | undefined, mark: () => void): string | undefined {
  return value === undefined ? undefined : boundString(value, MAX_STRING_CHARS, mark);
}

function boundString(value: string, max: number, mark: () => void): string {
  if (value.length <= max) return value;
  mark();
  return value.slice(0, max);
}
