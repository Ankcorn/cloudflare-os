import type { RpcStub } from 'capnweb'
import {
  AUTH_ERROR_MESSAGES, getAuthErrorCode, WORKERD_DEAD_CAPABILITY_MESSAGE,
  type AuthenticatedApi,
} from '@gadgets/workshop-shared/api'
import { reportIssue } from './errorReporting'

// Classifies errors surfaced through capnweb RPC. The backend runs with
// `enhanced_error_serialization`, so remote failures carry structured flags (workerd
// jsg/util.c++): `retryable` ⇔ the connection was lost, `overloaded` ⇔ the target pushed
// back, `durableObjectReset` ⇔ the target Durable Object was reset. Flags are authoritative;
// message matching is a fallback for errors that lose them in transit.

export type RpcErrorClass = 'do-reset' | 'connection' | 'auth' | 'other'

// Fallbacks: workerd errors normally arrive with `durableObjectReset` set (capnweb carries
// the flags in a dedicated slot); the first four strings only matter when something re-wrapped
// the error. The last is what LATER calls on an already-dead capability reject with — flagless;
// the flagged error only reaches calls in flight at reset time. Over our RPC surface a dead
// hosting context always means the capability needs reopening.
const DO_RESET_MESSAGES = [
  'Durable Object reset because its code was updated',
  'Durable Object storage operation exceeded timeout',
  "Durable Object's isolate exceeded its memory limit",
  'Durable Object exceeded its CPU time limit',
  WORKERD_DEAD_CAPABILITY_MESSAGE,
]

// Transport failures raised locally by capnweb, plus its own-session teardown message. These
// carry no flags, so matching messages is all we have; a canary test pins them to the installed
// capnweb build so an upgrade fails loudly here instead of silently in the UX.
export const CONNECTION_MESSAGES = [
  'Peer closed WebSocket',
  'WebSocket connection failed.',
  'RPC session was shut down by disposing the main stub',
  // What RPCs on an already-disposed stub reject with — e.g. the zombie the connection manager
  // disposes while an outage is being recovered.
  'Attempted to use RPC stub after it has been disposed',
]

// Fallback for auth errors thrown without a code (older deployments); codes are authoritative.
const AUTH_MESSAGES = Object.values(AUTH_ERROR_MESSAGES)

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

const flag = (err: unknown, name: string) =>
  (err as Record<string, unknown> | null | undefined)?.[name] === true

export function isDurableObjectResetError(err: unknown): boolean {
  return flag(err, 'durableObjectReset') || DO_RESET_MESSAGES.some(m => messageOf(err).includes(m))
}

export function isOverloadedError(err: unknown): boolean {
  return flag(err, 'overloaded')
}

export function getDurableObjectId(err: unknown): string | undefined {
  const id = (err as { durableObjectId?: unknown } | null | undefined)?.durableObjectId
  return typeof id === 'string' ? id : undefined
}

export function classifyRpcError(err: unknown): RpcErrorClass {
  if (isDurableObjectResetError(err)) return 'do-reset'
  const message = messageOf(err)
  if (flag(err, 'retryable') || CONNECTION_MESSAGES.some(m => message.includes(m))) {
    return 'connection'
  }
  // 'auth' is deliberately terminal — never quieted, never retried, and there is no missing
  // re-auth handler: the session is invalid and only a fresh login cures it.
  if (getAuthErrorCode(err) !== undefined || AUTH_MESSAGES.some(m => message.includes(m))) {
    return 'auth'
  }
  return 'other'
}

// True for failures that a healthy retry or reconnect is expected to cure.
export function isTransientRpcError(err: unknown): boolean {
  const cls = classifyRpcError(err)
  return cls === 'do-reset' || cls === 'connection'
}

// Logs an RPC failure: quietly for transient errors (a retry or reconnect is expected to cure
// them), loudly otherwise. Returns true when transient so call sites can skip their toasts.
// Pass `reportSite` from action paths (sends, creates) to also report do-reset errors to the
// client-errors endpoint, so resets that cost the user an action stay visible in telemetry.
export function logRpcFailure(
  message: string, err: unknown, options?: { reportSite?: string },
): boolean {
  const cls = classifyRpcError(err)
  if (cls === 'do-reset' && options?.reportSite) reportDoResetError(options.reportSite, err)
  const transient = cls === 'do-reset' || cls === 'connection'
  if (transient) console.debug(message, err)
  else console.error(message, err)
  return transient
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Retries an idempotent call once after a backend-side transient failure: a DO reset (the object
// restarts on its next request, reached via a fresh stub) or a `retryable`-flagged invocation
// failure. Flags only survive on errors that round-tripped from the backend, so a flagged error
// proves the socket was healthy and a retry-in-place can succeed. Local transport errors carry no
// flags and are deliberately not retried: the connection manager owns that recovery, and a retry
// through the closure-captured dead stub could never succeed anyway. Deliberately retries even
// when `overloaded` is set alongside the reset — the reset destroyed the queue that was
// overloaded, and one jittered attempt is not a retry loop. Never use for writes.
export async function withDoResetRetry<T>(fn: () => Promise<T>, delayMs = 1500): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!isDurableObjectResetError(err) && !flag(err, 'retryable')) throw err
    await sleep(delayMs * (0.75 + Math.random() * 0.5))
    return fn()
  }
}

/** Reports a DO-reset error to the client-errors endpoint (no-op unless reporting is enabled). */
export function reportDoResetError(site: string, err: unknown, options?: { gadgetId?: string }) {
  reportIssue(`do-reset.${site}`, err, { severity: 'warning', handled: true, ...options })
}

// The AuthenticatedApi methods that withReadRetries retries: idempotent reads whose results UI
// effects re-fetch anyway. Method-level, because idempotency is a property of the method, not
// of any one call site. Writes are deliberately absent — a retry after an ambiguous failure
// could double-apply them.
const RETRYING_READS = new Set<PropertyKey>([
  'listModels',
  'getQuickModel',
  'getAiConfig',
  'listGadgets',
  'listGatekeeperVendors',
  'listAddableGatekeepers',
  'isOnboardingCompleted',
  'subscribeConnectedAccounts',
])

// Wraps the authenticated API stub so the reads above transparently retry once after a
// backend-side transient failure (see withDoResetRetry). Installed once where the stub is
// created (useAuth), so every consumer gets the policy for free; everything else passes
// through untouched. All function-valued properties are forwarded via a fresh method call on
// the target: capnweb's callable property proxies treat property access (`.bind`, `.apply`)
// as RPC path segments, and its real methods (`then`, dispose) need the stub as receiver.
export function withReadRetries(api: RpcStub<AuthenticatedApi>): RpcStub<AuthenticatedApi> {
  const target = api as unknown as Record<PropertyKey, (...args: unknown[]) => unknown>
  return new Proxy(api, {
    get(_, prop) {
      const value = Reflect.get(api, prop)
      if (typeof value !== 'function') return value
      if (!RETRYING_READS.has(prop)) return (...args: unknown[]) => target[prop](...args)
      return (...args: unknown[]) =>
        withDoResetRetry(() => target[prop](...args) as Promise<unknown>)
    },
  })
}
