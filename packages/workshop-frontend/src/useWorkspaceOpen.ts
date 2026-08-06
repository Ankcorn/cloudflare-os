import { useEffect, useRef, useState } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import type {
  AuthenticatedApi,
  GadgetMetadata,
  ObserverAccountChoice,
  ObserverBindingNeed,
  ObserverConfigCallback,
  Overseer,
} from '@gadgets/workshop-shared/api'
import { reportIssue } from './errorReporting'
import {
  isTransientRpcError, logRpcFailure, reportDoResetError, setWorkspaceRecoveryHook,
} from './rpcErrors'
import { useDocumentTitle } from './useDocumentTitle'
import {
  classifyWorkspaceOpenFailure,
  type WorkspaceOpenFailureKind,
} from './components/WorkspaceOpenErrorPage'

const OBSERVER_CANCELLED = 'OBSERVER_CONFIG_CANCELLED'

// A reset can strand the pipelined open/subscribe pair without ever settling it, which would
// stall the recovery chain silently. This deadline turns a stalled attempt into a scheduled
// retry (resolving null). While `isPaused` returns true the deadline re-arms instead of firing —
// the observer-config modal legitimately blocks the open on user input.
const OPEN_SETTLEMENT_TIMEOUT_MS = 15000

// A successful open only resets the reopen backoff after the workspace has stayed healthy this
// long. Resetting eagerly would defeat the backoff under a flapping DO: each cycle opens fine
// (metadata subscribes), then a secondary subscription fails a beat later — with an eager reset
// that loops at the 500ms floor forever, which is exactly the hammering the backoff exists to
// prevent.
const REOPEN_GAP_RESET_AFTER_MS = 30000

function raceOpenSettlement<T extends { [Symbol.dispose](): void }>(
  promise: Promise<T>,
  isPaused: () => boolean,
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const arm = () => {
      timer = setTimeout(() => {
        if (isPaused()) arm()
        else {
          settled = true
          resolve(null)
        }
      }, OPEN_SETTLEMENT_TIMEOUT_MS)
    }
    arm()
    promise.then(
      value => {
        clearTimeout(timer)
        // A subscription arriving after we gave up belongs to a written-off attempt.
        if (settled) value[Symbol.dispose]()
        else {
          settled = true
          resolve(value)
        }
      },
      (err: unknown) => {
        clearTimeout(timer)
        if (!settled) {
          settled = true
          reject(err as Error)
        }
      },
    )
  })
}

export type WorkspaceLoadError =
  | { kind: 'open'; failure: WorkspaceOpenFailureKind }
  | { kind: 'message'; message: string }

type ObserverConfigState = {
  needs: ObserverBindingNeed[]
  resolve: (choices: ObserverAccountChoice[]) => void
  reject: (error: unknown) => void
}

type Options = {
  id: string | undefined
  authenticatedApi: RpcStub<AuthenticatedApi>
  onMetadata: (metadata: GadgetMetadata) => void
  onShareKeyConsumed: () => void
  onInvalidShareKey: () => void
}

export function useWorkspaceOpen({
  id,
  authenticatedApi,
  onMetadata,
  onShareKeyConsumed,
  onInvalidShareKey,
}: Options) {
  const [overseer, setOverseer] = useState<{ stub: RpcStub<Overseer> } | null>(null)
  const [metadata, setMetadata] = useState<GadgetMetadata | null>(null)
  const [error, setError] = useState<WorkspaceLoadError | null>(null)
  // True while a transient open failure is showing "Reconnecting…" — the workspace-level
  // recovery state, distinct from RpcContext's socket-level connectionLost.
  const [workspaceLost, setWorkspaceLost] = useState(false)
  const [observerConfig, setObserverConfig] = useState<ObserverConfigState | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const openWorkspaceIdRef = useRef<string | undefined>(undefined)
  const pendingObserverRejectRef = useRef<((error: unknown) => void) | null>(null)
  const reopenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reopenGapMsRef = useRef(0)
  const lastOpenSuccessAtRef = useRef<number | null>(null)
  const callbacksRef = useRef({ onMetadata, onShareKeyConsumed, onInvalidShareKey })
  callbacksRef.current = { onMetadata, onShareKeyConsumed, onInvalidShareKey }

  useDocumentTitle(error ? '' : metadata?.title)

  // Coalesces error bursts (every subscribed component fails at once) into one reopen, with
  // growing gaps so a wedged DO isn't hammered from every open tab: first reopen after a short
  // coalescing delay, then 5s doubling to a 60s cap. The gap starts over once the workspace has
  // stayed healthy for a while (see REOPEN_GAP_RESET_AFTER_MS). Delays are jittered so tabs
  // that saw the same reset don't stampede the recovering DO in lockstep.
  const scheduleReopen = () => {
    if (reopenTimerRef.current !== null) return
    const lastSuccess = lastOpenSuccessAtRef.current
    if (lastSuccess !== null && Date.now() - lastSuccess > REOPEN_GAP_RESET_AFTER_MS) {
      reopenGapMsRef.current = 0
    }
    const delayMs = Math.max(500, reopenGapMsRef.current) * (0.85 + 0.3 * Math.random())
    reopenTimerRef.current = setTimeout(() => {
      reopenTimerRef.current = null
      setReloadNonce(value => value + 1)
    }, delayMs)
    reopenGapMsRef.current = Math.min(Math.max(reopenGapMsRef.current * 2, 5000), 60000)
  }

  // The workspace's single recovery entry point. A DO reset — or the worker losing its
  // connection to the DO (`retryable`) — rejects in-flight RPCs while the browser socket stays
  // healthy, so nothing re-runs the open effect on its own; instead, every do-reset that any
  // call site quiets through logRpcFailure lands here, is reported tagged with this workspace
  // when the site named itself, and schedules a coalesced reopen. The ref indirection keeps the
  // registration effect dependency-free while always running the current render's closure.
  const recoverRef = useRef<(err: unknown, reportSite?: string) => void>(() => {})
  recoverRef.current = (err, reportSite) => {
    if (reportSite) reportDoResetError(reportSite, err, { gadgetId: id })
    scheduleReopen()
  }
  useEffect(() => {
    setWorkspaceRecoveryHook((err, reportSite) => recoverRef.current(err, reportSite))
    return () => setWorkspaceRecoveryHook(null)
  }, [])

  useEffect(() => {
    let overseerStub: RpcStub<Overseer> | null = null
    let metadataSubscription: RpcStub<{}> | null = null
    let configureObservers: RpcStub<ObserverConfigCallback> | null = null
    let cancelled = false
    const hadOpenWorkspace = id !== undefined && openWorkspaceIdRef.current === id

    const disposeAttempt = () => {
      metadataSubscription?.[Symbol.dispose]()
      overseerStub?.[Symbol.dispose]()
      configureObservers?.[Symbol.dispose]()
      metadataSubscription = null
      overseerStub = null
      configureObservers = null
    }

    const showTerminalError = (nextError: WorkspaceLoadError) => {
      disposeAttempt()
      openWorkspaceIdRef.current = undefined
      setOverseer(null)
      setMetadata(null)
      setWorkspaceLost(false)
      setError(nextError)
    }

    const load = async () => {
      if (!id) {
        showTerminalError({ kind: 'open', failure: 'not-found' })
        return
      }
      if (!hadOpenWorkspace) setError(null)

      try {
        const hash = window.location.hash
        const shareKey = hash.startsWith('#share=') ? hash.slice('#share='.length) : undefined
        if (shareKey) callbacksRef.current.onShareKeyConsumed()

        const configureObserversTarget = new (class extends RpcTarget implements ObserverConfigCallback {
          configure(needs: ObserverBindingNeed[]): Promise<ObserverAccountChoice[]> {
            if (cancelled) return Promise.reject(new Error('Cancelled'))
            return new Promise<ObserverAccountChoice[]>((resolve, reject) => {
              pendingObserverRejectRef.current = reject
              setObserverConfig({
                needs,
                resolve: choices => {
                  pendingObserverRejectRef.current = null
                  setObserverConfig(null)
                  resolve(choices)
                },
                reject: observerError => {
                  pendingObserverRejectRef.current = null
                  setObserverConfig(null)
                  reject(observerError)
                },
              })
            })
          }
        })()
        configureObservers = new RpcStub(configureObserversTarget)

        overseerStub = authenticatedApi.openGadget(id, shareKey, configureObservers)
        // No onRpcBroken here: a workerd probe showed it never fires for a DO-backed capability
        // while the session lives (session-teardown only), so recovery rides on the logRpcFailure
        // recovery hook instead. The hook can't see a reset that rejects nothing: a workspace
        // idle at reset time recovers on its next failing call.
        setOverseer({ stub: overseerStub })

        const settledSubscription = await raceOpenSettlement(
          overseerStub.subscribeToMetadata((nextMetadata) => {
            if (cancelled) return
            setMetadata(nextMetadata)
            callbacksRef.current.onMetadata(nextMetadata)
          }),
          () => pendingObserverRejectRef.current !== null,
        )
        if (settledSubscription === null) {
          if (cancelled) return
          console.debug('Workspace open attempt never settled; retrying.')
          reportIssue('workspace.open-stalled', new Error('workspace open attempt never settled'), {
            severity: 'warning', handled: true, gadgetId: id,
          })
          scheduleReopen()
          if (!workspaceLost) setWorkspaceLost(true)
          return
        }
        if (cancelled) {
          settledSubscription[Symbol.dispose]()
          return
        }
        metadataSubscription = settledSubscription

        openWorkspaceIdRef.current = id
        lastOpenSuccessAtRef.current = Date.now()
        setError(null)
        if (workspaceLost) setWorkspaceLost(false)
      } catch (caught) {
        if (cancelled) return
        // For a do-reset this also reports (tagged with this workspace) and schedules the reopen
        // via the recovery hook; the transient branch below only adds the "Reconnecting…" state.
        logRpcFailure('Failed to load gadget:', caught, { reportSite: 'workspace.open' })

        // TODO: Give share-link and observer failures stable codes so this remaining legacy
        // message classification can be removed.
        const message = caught instanceof Error ? caught.message : ''
        if (message.includes('Invalid or expired share key')) {
          callbacksRef.current.onInvalidShareKey()
        }
        if (message.includes(OBSERVER_CANCELLED)) {
          showTerminalError({
            kind: 'message',
            message: 'To open this workspace, you must choose connected accounts for the services it uses.',
          })
        } else if (message.includes('permitted to observe') ||
                   message.includes('no longer connected') ||
                   message.includes('connect an account for every service')) {
          showTerminalError({ kind: 'message', message })
        } else {
          const failure = classifyWorkspaceOpenFailure(caught)
          if (failure !== 'unexpected') {
            showTerminalError({ kind: 'open', failure })
          } else if (isTransientRpcError(caught)) {
            // Reset or dropped connection: keep the workspace mounted, show "Reconnecting…", and
            // retry on the growing schedule — a failure on a healthy socket gets no other retry.
            scheduleReopen()
            if (!workspaceLost) setWorkspaceLost(true)
          } else if (!hadOpenWorkspace) {
            reportIssue('gadget.load', caught, { gadgetId: id })
            showTerminalError({ kind: 'open', failure })
          } else if (!workspaceLost) {
            setWorkspaceLost(true)
          }
        }
      }
    }

    void load()
    return () => {
      cancelled = true
      if (reopenTimerRef.current !== null) {
        clearTimeout(reopenTimerRef.current)
        reopenTimerRef.current = null
      }
      if (pendingObserverRejectRef.current) {
        pendingObserverRejectRef.current(new Error('Cancelled'))
        pendingObserverRejectRef.current = null
      }
      setObserverConfig(null)
      disposeAttempt()
    }
  }, [id, authenticatedApi, reloadNonce])

  return {
    overseer,
    metadata,
    error,
    workspaceLost,
    observerConfig,
    retry() {
      setError(null)
      setReloadNonce(value => value + 1)
    },
    cancelObserverConfig() {
      observerConfig?.reject(new Error(OBSERVER_CANCELLED))
    },
    updateTitle(title: string) {
      setMetadata(previous => previous ? { ...previous, title } : null)
    },
  }
}
