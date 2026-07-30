import { useState, useEffect, useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useParams, useNavigate, useSearch, Link } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import {
  ShareNetwork,
  Pencil,
  Check,
  X,
  Hexagon,
  Blueprint,
  Trash,
  CornersOut,
} from '@phosphor-icons/react'
import { RpcStub, RpcTarget } from 'capnweb'
import { useAuthenticatedApi } from './AuthContext'
import UserMenu from './components/UserMenu'
import { reportIssue } from './errorReporting'

import {
  Overseer,
  GadgetClient,
  GadgetMetadata,
  AiChatAuthorInfo,
  ConsoleLogSubscriber,
  ConsoleLogEvent,
  ObserverConfigCallback,
  ObserverBindingNeed,
  ObserverAccountChoice,
  WorkpieceId,
  WorkpieceSummary,
  WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'
import ObserverConfigModal from './ObserverConfigModal'
import GadgetCodeInterface from './GadgetCodeInterface'
import GadgetUI from './GadgetUI'
import GadgetUseView from './GadgetUseView'
import Connections from './Connections'
import Activity from './Activity'
import WorkpiecePicker from './WorkpiecePicker'
import ChatInterface, { type StreamingProposedChanges, type ActiveFileTarget } from './ChatInterface'
import ShareModal from './ShareModal'
import { GadgetPresence } from './components/GadgetPresence'
import BlueprintModal from './BlueprintModal'
import TopBarNotice from './TopBarNotice'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from './components/WorkshopControls'
import { TabButton } from './components/TabButton'
import { useActions } from './useActions'
import DeleteConfirmationDialog from './components/DeleteConfirmationDialog'
import { useDocumentTitle } from './useDocumentTitle'

// ─── console log subscriber ───────────────────────────────────────────────────

type BufferedLogEntry = ConsoleLogEvent & { source: 'server' | 'client' }

class ConsoleLogSubscriberImpl extends RpcTarget implements ConsoleLogSubscriber {
  selectedChatIdRef: { current: number | null } = { current: null }
  logBufferRef: { current: BufferedLogEntry[] } = { current: [] }
  onBufferUpdated: () => void = () => {}

  async event(chatId: number | null, logs: ConsoleLogEvent[]) {
    for (const log of logs) {
      const method = (console as any)[log.level] ?? console.log
      method('server:', ...log.message)
    }
    // If the logs are not associated with any chat, deliver to the current chat. If they are
    // associated with a chat, this implies that the logs come from a version of the gadget that
    // has proposed changes from that chat; only deliver if it matches the current chat.
    if (chatId === null || chatId === this.selectedChatIdRef.current) {
      this.logBufferRef.current.push(...logs.map(l => ({ ...l, source: 'server' as const })))
      this.onBufferUpdated()
    }
  }
}

// ─── workpieces subscriber ────────────────────────────────────────────────────

// Receives the workspace's workpiece list (see Overseer.subscribeToWorkpieces()). Entries
// received before ready() are buffered so a (re)subscription replaces the list atomically instead
// of flashing a partially-populated one.
class WorkpiecesSubscriberImpl extends RpcTarget implements WorkpiecesSubscriber {
  private buffer: Map<WorkpieceId, WorkpieceSummary> | null = new Map()
  private cancelled = false

  constructor(
    private onUpdate: (
      update: (prev: Map<WorkpieceId, WorkpieceSummary>) => Map<WorkpieceId, WorkpieceSummary>,
    ) => void,
    private onReady: (initial: Map<WorkpieceId, WorkpieceSummary>) => void,
  ) {
    super()
  }

  entry(summary: WorkpieceSummary) {
    if (this.cancelled) return
    if (this.buffer) {
      this.buffer.set(summary.id, summary)
      return
    }
    this.onUpdate(prev => new Map(prev).set(summary.id, summary))
  }

  removed(id: WorkpieceId) {
    if (this.cancelled) return
    if (this.buffer) {
      this.buffer.delete(id)
      return
    }
    this.onUpdate(prev => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }

  ready() {
    if (this.cancelled) return
    const initial = this.buffer ?? new Map<WorkpieceId, WorkpieceSummary>()
    this.buffer = null
    this.onReady(initial)
  }

  // local call
  cancel() {
    this.cancelled = true
  }
}

function formatConsoleLogs(logs: BufferedLogEntry[]): string {
  const lines = logs.map(log => {
    const parts = log.message.map(p => (typeof p === 'string' ? p : JSON.stringify(p)))
    return `[${log.source} ${log.level}] ${parts.join(' ')}`
  })
  return 'Console logs:\n' + lines.join('\n')
}

// ─── right-panel tabs ─────────────────────────────────────────────────────────

type RightTab = 'app' | 'code' | 'connections' | 'activity'

type WorkspaceOverride = 'open' | 'closed' | null

function formatHeaderCost(cost: number) {
  if (cost === 0) return '$0'
  if (cost < 0.01) return '<$0.01'
  return `$${cost.toFixed(2)}`
}

const RIGHT_TABS: { value: RightTab; label: string }[] = [
  { value: 'app', label: 'Gadget' },
  { value: 'code', label: 'Code' },
  { value: 'connections', label: 'Connections' },
  { value: 'activity', label: 'Activity' },
]

const CHAT_WIDTH_STORAGE_KEY = 'gadgets:workshop:chatWidth'
const WORKSPACE_VISIBILITY_STORAGE_KEY_PREFIX = 'gadgets:workshop:workspaceVisibility:'
const MIN_CHAT_WIDTH = 280
const MIN_WORKSPACE_WIDTH = 400
const DEFAULT_CHAT_WIDTH = 420

const isBrowser = typeof window !== 'undefined'

function clampChatWidth(width: number) {
  if (!isBrowser) return Math.max(MIN_CHAT_WIDTH, Math.min(DEFAULT_CHAT_WIDTH, width))
  const max = Math.max(MIN_CHAT_WIDTH, window.innerWidth - MIN_WORKSPACE_WIDTH)
  return Math.max(MIN_CHAT_WIDTH, Math.min(max, width))
}

function getInitialChatWidth() {
  if (!isBrowser) return DEFAULT_CHAT_WIDTH
  const fallback = Math.min(DEFAULT_CHAT_WIDTH, Math.floor(window.innerWidth * 0.38))
  let parsed = NaN
  try {
    const stored = window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY)
    if (stored) parsed = Number(stored)
  } catch {
    // private mode / sandboxed iframes
  }
  return clampChatWidth(Number.isFinite(parsed) ? parsed : fallback)
}

function workspaceVisibilityStorageKey(gadgetId: string) {
  // Per-gadget keys may outlive deleted gadgets, but each entry is tiny and bounded by gadgets
  // created or opened.
  return `${WORKSPACE_VISIBILITY_STORAGE_KEY_PREFIX}${gadgetId}`
}

function getStoredWorkspaceOverride(gadgetId: string | undefined): WorkspaceOverride {
  if (!isBrowser || !gadgetId) return null
  try {
    const stored = window.localStorage.getItem(workspaceVisibilityStorageKey(gadgetId))
    return stored === 'open' || stored === 'closed' ? stored : null
  } catch {
    return null
  }
}

// Shown in gadget-scoped tabs when the workspace has no (visible) gadgets yet. Gadgets are
// created by the agent, so point the user back at the chat.
function NoGadgetPlaceholder({ height }: { height: string }) {
  return (
    <div className="flex items-center justify-center px-6 text-center" style={{ height }}>
      <div className="max-w-[360px]">
        <p className="m-0 text-[15px] leading-[22px] font-semibold tracking-[-0.3px] text-kumo-default">
          No gadgets yet
        </p>
        <p className="mt-1.5 mb-0 text-[13px] leading-[19px] tracking-[-0.25px] text-kumo-subtle">
          Ask the agent in chat to build something, and it will appear here.
        </p>
      </div>
    </div>
  )
}

// ─── component ────────────────────────────────────────────────────────────────

export default function GadgetEditor() {
  const params = useParams({ strict: false }) as { id?: string }
  const id = params.id
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()

  const { chat: chatParam, w: workpieceParam } = useSearch({ strict: false }) as
    { chat?: number; w?: number }
  const urlChatId = chatParam !== undefined ? chatParam : null
  const urlWorkpieceId = workpieceParam !== undefined ? workpieceParam : null

  // ── toasts ─────────────────────────────────────────────────────────────────────
  const toasts = useKumoToastManager()

  // ── core state ──────────────────────────────────────────────────────────────
  const [overseer, setOverseer] = useState<{ stub: RpcStub<Overseer> } | null>(null)
  // The workspace's workpiece list (gadget-type workpieces only in v1), kept live via
  // subscribeToWorkpieces(). `workpiecesReady` flips once the initial listing has arrived.
  const [workpieces, setWorkpieces] = useState<Map<WorkpieceId, WorkpieceSummary>>(new Map())
  const [workpiecesReady, setWorkpiecesReady] = useState(false)
  // GadgetClient stub for the currently-selected gadget workpiece. Per-gadget operations (UI
  // bundle, RPC connection, bindings, blueprints) go through this stub. Null while the workspace
  // has no (visible) gadgets.
  const [gadget, setGadget] = useState<{ id: WorkpieceId; stub: RpcStub<GadgetClient> } | null>(null)
  const [metadata, setMetadata] = useState<GadgetMetadata | null>(null)
  useDocumentTitle(metadata?.title)
  const [error, setError] = useState<string | null>(null)
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  // Bumped by the error page's "Try again" to re-run the load effect.
  const [reloadNonce, setReloadNonce] = useState(0)
  const [connectionLost, setConnectionLost] = useState(false)
  const [userInfo, setUserInfo] = useState<AiChatAuthorInfo | null>(null)

  // ── observer account configuration ───────────────────────────────────────────
  // When a non-owner opens a shared gadget that reads data through gatekeeper bindings they
  // haven't yet configured, the overseer calls back to ask them to choose connected accounts.
  // We surface that as a modal; resolving it lets open() proceed, rejecting it denies the open.
  const [observerConfig, setObserverConfig] = useState<{
    needs: ObserverBindingNeed[]
    resolve: (choices: ObserverAccountChoice[]) => void
    reject: (err: unknown) => void
  } | null>(null)
  // Holds the in-flight configure() rejection so the load effect's cleanup can abort a pending
  // prompt (e.g. if the user navigates away while the modal is open).
  const pendingObserverRejectRef = useRef<((err: unknown) => void) | null>(null)

  // Sentinel message used when the user dismisses the observer-config modal, so the load catch can
  // distinguish a deliberate cancel from a genuine access denial.
  const OBSERVER_CANCELLED = 'OBSERVER_CONFIG_CANCELLED'

  // ── role gating ────────────────────────────────────────────────────────────────
  // "use"-role collaborators receive a restricted overseer that only permits rendering and
  // interacting with the gadget's deployed UI. We render the minimal use-only view for them (see
  // the early return below). Editor-only RPCs are fired speculatively regardless of role: the
  // restricted overseer denies the ones that matter and returns inert results for the two
  // telemetry subscriptions this component opens, so no client-side gating is needed here.
  const isUseOnly = metadata?.role === 'use'

  // ── title editing ────────────────────────────────────────────────────────────
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const isEditingTitleRef = useRef(false)
  isEditingTitleRef.current = isEditingTitle
  const [titleInput, setTitleInput] = useState('')

  // ── layout ───────────────────────────────────────────────────────────────────
  const [chatWidth, setChatWidth] = useState(getInitialChatWidth)
  const chatWidthRef = useRef(chatWidth)
  const [isResizing, setIsResizing] = useState(false)
  const [activeTab, setActiveTab] = useState<RightTab>('app')
  const [workspaceOverride, setWorkspaceOverride] = useState<WorkspaceOverride>(() =>
    getStoredWorkspaceOverride(id)
  )
  const [workspaceTransitionEnabled, setWorkspaceTransitionEnabled] = useState(false)
  const [hasMountedActivity, setHasMountedActivity] = useState(false)
  const [shareModalOpen, setShareModalOpen] = useState(false)
  const [blueprintModalOpen, setBlueprintModalOpen] = useState(false)
  const [previewMode, _setPreviewMode] = useState(false)

  // Fullscreen gadget mode — renders the gadget iframe as an overlay covering the whole page.
  // Tied to the URL hash (#fullscreen) so the state is bookmarkable and survives reloads.
  const [isGadgetFullscreen, setIsGadgetFullscreen] = useState(
    () => typeof window !== 'undefined' && window.location.hash === '#fullscreen'
  )

  useEffect(() => {
    const onHashChange = () => {
      setIsGadgetFullscreen(window.location.hash === '#fullscreen')
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Brief hint banner shown when entering fullscreen, instructing the user how to exit.
  // We don't use the global Kumo toast manager here because the fullscreen overlay sits above
  // it in stacking order (and toasts render bottom-right, not top-center).
  const [showFullscreenHint, setShowFullscreenHint] = useState(false)
  // Element that had focus before entering fullscreen; we restore focus to it on exit so
  // keyboard users aren't stranded.
  const focusBeforeFullscreenRef = useRef<HTMLElement | null>(null)
  // Fullscreen overlay wrapper — we focus this on enter to move focus out of the now-occluded
  // Enter button. From here, Tab moves into the iframe.
  const fullscreenOverlayRef = useRef<HTMLDivElement>(null)

  const enterGadgetFullscreen = useCallback(() => {
    if (window.location.hash !== '#fullscreen') {
      // pushState so the browser Back button also exits fullscreen — natural for many users
      // and helpful for bookmarks: a bookmarked /gadget/foo#fullscreen can still go Back to a
      // useful (non-fullscreen) state if there's prior history.
      window.history.pushState(null, '', '#fullscreen')
    }
    focusBeforeFullscreenRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setIsGadgetFullscreen(true)
    setShowFullscreenHint(true)
  }, [])

  // Auto-dismiss the hint a few seconds after entering fullscreen.
  useEffect(() => {
    if (!showFullscreenHint) return
    const t = setTimeout(() => setShowFullscreenHint(false), 4000)
    return () => clearTimeout(t)
  }, [showFullscreenHint])

  // Move focus into the overlay when entering fullscreen, and back to the prior element on exit.
  useEffect(() => {
    if (isGadgetFullscreen) {
      fullscreenOverlayRef.current?.focus()
    } else if (focusBeforeFullscreenRef.current) {
      focusBeforeFullscreenRef.current.focus()
      focusBeforeFullscreenRef.current = null
    }
  }, [isGadgetFullscreen])

  const exitGadgetFullscreen = useCallback(() => {
    if (window.location.hash === '#fullscreen') {
      // Replace the hash without growing the history stack.
      const { pathname, search } = window.location
      window.history.replaceState(null, '', `${pathname}${search}`)
    }
    setIsGadgetFullscreen(false)
  }, [])

  // Escape exits fullscreen. When focus is in the workshop chrome this listener catches it
  // directly; when focus is in the gadget iframe, the iframe forwards Escape via postMessage
  // (see GadgetUI's `onIframeEscape`).
  useEffect(() => {
    if (!isGadgetFullscreen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitGadgetFullscreen()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isGadgetFullscreen, exitGadgetFullscreen])

  // ── code / chat state ────────────────────────────────────────────────────────
  const [uiReloadTrigger, setUiReloadTrigger] = useState(0)
  const [autoApproveReloadTrigger, setAutoApproveReloadTrigger] = useState(0)
  const [proposedChanges, setProposedChanges] = useState<Uint8Array | undefined>(undefined)
  const [draftProposedChanges, setDraftProposedChanges] = useState<StreamingProposedChanges | undefined>(undefined)
  const [streamingProposedChanges, setStreamingProposedChanges] = useState<StreamingProposedChanges | undefined>(undefined)
  const [streamingActiveFile, setStreamingActiveFile] = useState<ActiveFileTarget | null | undefined>(undefined)
  const [hasCode, setHasCode] = useState<boolean | null>(null)
  const [chatCount, setChatCount] = useState<number | null>(null)
  const [hasChatZero, setHasChatZero] = useState(false)
  const [_hasBindings, setHasBindings] = useState(false)
  const [isAgentActive, setIsAgentActive] = useState(false)
  const [hasAnyProposedChanges, setHasAnyProposedChanges] = useState(false)
  const [selectedChatHasProposedChanges, setSelectedChatHasProposedChanges] = useState(false)
  const selectedChatId = urlChatId
  const chatListReady = chatCount !== null
  const singleInitialChat = chatCount === 1 && hasChatZero
  const [userNavigatedToList, setUserNavigatedToList] = useState(false)
  // Note: raw `hasCode` (not `effectiveHasCode` below) is deliberate here, to avoid a dependency
  // cycle: the effective value depends on the selected workpiece, whose pending-gadget visibility
  // depends on `effectiveSelectedChatId`, which depends on this pin. When no gadget is selected
  // yet, `hasCode` is null and the pin stays on -- the right behavior for new workspaces.
  const pinInitialChatSelection =
    singleInitialChat && hasCode !== true && !userNavigatedToList

  // Before any code has been merged, a single-thread gadget conceptually only
  // has one useful conversation, so keep chat 0 selected even if the URL has
  // not caught up yet. As soon as merged code exists, dropping back to the chat
  // list should become possible.
  const effectiveSelectedChatId = selectedChatId ?? (pinInitialChatSelection ? 0 : null)

  // ── workpiece selection ──────────────────────────────────────────────────────
  // Gadget workpieces visible in the current context. A pending (chat-provisional) gadget is
  // only listed while the chat it was created in is the one currently open.
  const visibleGadgets = useMemo(() => {
    return [...workpieces.values()]
      .filter(w => w.type === 'gadget' &&
        (w.chatId === undefined || w.chatId === effectiveSelectedChatId))
      .toSorted((a, b) => a.id - b.id)
  }, [workpieces, effectiveSelectedChatId])

  // The selected gadget: the URL's `?w=` param when it names a visible gadget, else the
  // workspace's default gadget, else the lowest-numbered visible gadget. Null when the workspace
  // has no visible gadgets.
  const selectedGadgetId = useMemo(() => {
    if (urlWorkpieceId !== null && visibleGadgets.some(g => g.id === urlWorkpieceId)) {
      return urlWorkpieceId
    }
    const defaultId = metadata?.defaultGadgetId
    if (defaultId !== undefined && visibleGadgets.some(g => g.id === defaultId)) {
      return defaultId
    }
    return visibleGadgets.length > 0 ? visibleGadgets[0].id : null
  }, [urlWorkpieceId, visibleGadgets, metadata?.defaultGadgetId])

  const selectedGadgetSummary = selectedGadgetId !== null
    ? visibleGadgets.find(g => g.id === selectedGadgetId)
    : undefined
  const selectedFilesRoot = selectedGadgetSummary?.filesRoot
  // The stub for the selected gadget arrives via an effect; during a switch it briefly lags the
  // selection, in which case gadget-dependent views render their empty states for a frame.
  const selectedGadgetStub =
    gadget !== null && gadget.id === selectedGadgetId ? gadget.stub : null
  // The file the agent is streaming edits into, when it is in the selected gadget. (Edits going
  // to a different gadget instead auto-switch the picker; see the effect below.)
  const streamingActiveFileForSelected =
    streamingActiveFile != null && streamingActiveFile.workpieceId === selectedGadgetId
      ? streamingActiveFile.filename
      : undefined

  // Whether the *selected* gadget has code. When no gadget is selected, the code interface is
  // unmounted and raw `hasCode` can't update, but a gadget-less workspace has no code to show.
  const effectiveHasCode = selectedFilesRoot !== undefined
    ? hasCode
    : workpiecesReady ? false : null

  const codeStateReady = effectiveHasCode !== null
  const hasCodeRelatedState = effectiveHasCode === true
    || hasAnyProposedChanges
    || streamingProposedChanges !== undefined
  const layoutModeReady = chatListReady && (codeStateReady || hasCodeRelatedState)

  // Simple mode: full-width chat layout for a brand-new workspace whose only conversation is
  // chat 0 and which still has no merged or proposed code -- and at most one gadget, since with
  // more the workpiece picker must be reachable. We only choose this layout after the initial
  // chat/code/workpiece subscriptions are ready, so existing gadgets do not briefly flash the
  // wrong UI while loading.
  const simpleMode = layoutModeReady && !hasCodeRelatedState && singleInitialChat
    && visibleGadgets.length <= 1
  const showFullEditor = layoutModeReady && (
    workspaceOverride === null ? !simpleMode : workspaceOverride === 'open'
  )
  const workspaceTransitionClass = workspaceTransitionEnabled && !isResizing
    ? 'transition-[width,opacity] duration-200 ease-out'
    : ''

  const previewChatId =
    selectedChatHasProposedChanges && effectiveSelectedChatId !== null
      ? effectiveSelectedChatId
      : undefined

  // ── console log buffering ────────────────────────────────────────────────────
  const consoleLogSubscriberRef = useRef(new ConsoleLogSubscriberImpl())
  const consoleLogBufferRef = useRef<BufferedLogEntry[]>([])
  const [consoleLogCount, setConsoleLogCount] = useState(0)
  const selectedChatIdRef = useRef(effectiveSelectedChatId)
  selectedChatIdRef.current = effectiveSelectedChatId
  consoleLogSubscriberRef.current.selectedChatIdRef = selectedChatIdRef
  consoleLogSubscriberRef.current.logBufferRef = consoleLogBufferRef
  consoleLogSubscriberRef.current.onBufferUpdated = () =>
    setConsoleLogCount(consoleLogBufferRef.current.length)

  useEffect(() => {
    consoleLogBufferRef.current = []
    setConsoleLogCount(0)
  }, [effectiveSelectedChatId])

  const consumeConsoleLogs = useCallback((): string => {
    const logs = consoleLogBufferRef.current
    consoleLogBufferRef.current = []
    setConsoleLogCount(0)
    return formatConsoleLogs(logs)
  }, [])

  const discardConsoleLogs = useCallback(() => {
    consoleLogBufferRef.current = []
    setConsoleLogCount(0)
  }, [])

  chatWidthRef.current = chatWidth

  const handleClientConsoleLog = useCallback((log: ConsoleLogEvent) => {
    const method = (console as any)[log.level] ?? console.log
    method('client:', ...log.message)
    if (selectedChatIdRef.current !== null) {
      consoleLogBufferRef.current.push({ ...log, source: 'client' as const })
      setConsoleLogCount(consoleLogBufferRef.current.length)
    }
  }, [])

  const persistChatWidth = useCallback((width: number) => {
    try {
      window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(Math.round(width)))
    } catch {
      // private mode / sandboxed iframes
    }
  }, [])

  const setWorkspaceVisibility = useCallback((visibility: Exclude<WorkspaceOverride, null>) => {
    setWorkspaceTransitionEnabled(true)
    setWorkspaceOverride(visibility)
    if (!id) return
    try {
      window.localStorage.setItem(workspaceVisibilityStorageKey(id), visibility)
    } catch {
      // The control still works for the current session when storage is unavailable.
    }
  }, [id])

  useEffect(() => {
    const handleResize = () => {
      setChatWidth(width => clampChatWidth(width))
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    if (activeTab === 'activity') setHasMountedActivity(true)
  }, [activeTab])

  // Pending-actions badge count; shares an RPC subscription with Activity / ChatInterface.
  const { actionsById } = useActions(overseer?.stub ?? null)
  const pendingActionsCount = useMemo(() => {
    let count = 0
    for (const record of actionsById.values()) {
      if (record.state === 'pending') count++
    }
    return count
  }, [actionsById])

  // ── chat count / auto-switch ─────────────────────────────────────────────────
  const handleChatCountChange = useCallback((count: number, chatZeroExists: boolean) => {
    setChatCount(count)
    setHasChatZero(chatZeroExists)
  }, [])

  const hasAutoSwitchedToCodeRef = useRef(false)
  const hasAutoSwitchedToUiRef = useRef(false)
  const hadProposedChangesAtAgentStartRef = useRef(false)
  // Set when an agent turn that started without proposed changes finishes; the actual switch to the
  // gadget UI happens in the effect below, once `proposedChanges` reflects the turn's changes.
  const pendingAutoSwitchToUiRef = useRef(false)
  const proposedChangesRef = useRef(proposedChanges)
  proposedChangesRef.current = proposedChanges

  const handleAgentActiveChange = useCallback((chatId: number, isActive: boolean) => {
    setIsAgentActive(isActive)
    if (chatId !== 0) return
    if (isActive) {
      hadProposedChangesAtAgentStartRef.current = proposedChangesRef.current !== undefined
      // A new turn started; re-evaluate whether to auto-switch when it finishes.
      pendingAutoSwitchToUiRef.current = false
    } else {
      // Arm the auto-switch rather than reading proposedChanges synchronously: the turn's
      // "changes" message and the agent-inactive metadata update now arrive together, and
      // `proposedChanges` lags by a render or two. The effect below completes the switch once it
      // catches up.
      if (!hasAutoSwitchedToUiRef.current && !hadProposedChangesAtAgentStartRef.current) {
        pendingAutoSwitchToUiRef.current = true
      }
    }
  }, [])

  // Auto-switch to the gadget UI after the first turn that produced code finishes. Driven by
  // `proposedChanges`/`isAgentActive` state so it fires even when `proposedChanges` resolves after
  // the agent-inactive transition.
  useEffect(() => {
    if (
      pendingAutoSwitchToUiRef.current &&
      !isAgentActive &&
      proposedChanges !== undefined &&
      !hasAutoSwitchedToUiRef.current
    ) {
      pendingAutoSwitchToUiRef.current = false
      hasAutoSwitchedToUiRef.current = true
      setActiveTab('app')
    }
  }, [proposedChanges, isAgentActive])

  // Show the Code tab while a fresh gadget's first files are being written.
  useEffect(() => {
    if (
      streamingProposedChanges !== undefined &&
      !hasAutoSwitchedToCodeRef.current &&
      !effectiveHasCode
    ) {
      hasAutoSwitchedToCodeRef.current = true
      setActiveTab('code')
    }
  }, [streamingProposedChanges, effectiveHasCode])

  useEffect(() => {
    setProposedChanges(undefined)
    setDraftProposedChanges(undefined)
    setStreamingProposedChanges(undefined)
    setStreamingActiveFile(undefined)
    setHasCode(null)
    setChatCount(null)
    setHasChatZero(false)
    setHasAnyProposedChanges(false)
    setSelectedChatHasProposedChanges(false)
    setWorkspaceOverride(getStoredWorkspaceOverride(id))
    setWorkspaceTransitionEnabled(false)
    setHasMountedActivity(false)
    setWorkpieces(new Map())
    setWorkpiecesReady(false)
    hasAutoSwitchedToCodeRef.current = false
    hasAutoSwitchedToUiRef.current = false
    hadProposedChangesAtAgentStartRef.current = false
    pendingAutoSwitchToUiRef.current = false
    setUserNavigatedToList(false)
  }, [id])

  // ── navigation helper ────────────────────────────────────────────────────────
  const navigateToChat = useCallback(
    (chatId: number | null, options?: { replace?: boolean }) => {
      setUserNavigatedToList(chatId === null)
      navigate({
        to: '/gadget/$id',
        params: { id: id! },
        // Preserve the workpiece selection (`?w=`) across chat navigation.
        search: (prev: Record<string, unknown>) =>
          ({ ...prev, chat: chatId !== null ? chatId : undefined }),
        replace: options?.replace,
      })
    },
    [id, navigate]
  )

  // ── keep single-chat routing aligned with the current mode ──────────────────
  // Keep the URL aligned with simple mode's implied chat-0 selection.
  useEffect(() => {
    if (!layoutModeReady) return

    if (simpleMode) {
      if (urlChatId === 0) {
        navigate({
          to: '/gadget/$id',
          params: { id: id! },
          search: (prev: Record<string, unknown>) => ({ ...prev, chat: undefined }),
          replace: true,
        })
      }
      return
    }

    if (pinInitialChatSelection && urlChatId === null) {
      navigateToChat(0, { replace: true })
    }
  }, [layoutModeReady, simpleMode, pinInitialChatSelection, urlChatId, navigateToChat, navigate, id])

  // ── resize handle ─────────────────────────────────────────────────────────────
  //
  // Pointer capture keeps resizing reliable when dragging across the gadget iframe.
  const handleResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!showFullEditor) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      setIsResizing(true)
    },
    [showFullEditor],
  )
  const handleResizePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      setChatWidth(clampChatWidth(e.clientX))
    },
    [],
  )
  const handleResizePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      const width = e.type === 'pointercancel'
        ? chatWidthRef.current
        : clampChatWidth(e.clientX)
      setChatWidth(width)
      persistChatWidth(width)
      setIsResizing(false)
    },
    [persistChatWidth],
  )

  useEffect(() => {
    if (!isResizing) return
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    return () => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [isResizing])

  // ── load gadget ───────────────────────────────────────────────────────────────
  useEffect(() => {
    let overseerStub: RpcStub<Overseer> | null = null
    let metaSub: RpcStub<{}> | null = null
    let configureObservers: RpcStub<ObserverConfigCallback> | null = null
    let cancelled = false

    const load = async () => {
      if (!id) { setError('No gadget ID provided'); return }
      if (isInitialLoad) setError(null)

      try {
        const hash = window.location.hash
        const shareKey = hash.startsWith('#share=') ? hash.slice('#share='.length) : undefined
        if (shareKey) navigate({ to: '/gadget/$id', params: { id: id! }, search: {}, replace: true })

        // Invoked by the overseer only if we're a non-owner who must choose connected accounts for
        // one or more gatekeeper bindings before observing the gadget (see ObserverConfigModal).
        // In the common case it is never called and open() pipelines as before.
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
                reject: err => {
                  pendingObserverRejectRef.current = null
                  setObserverConfig(null)
                  reject(err)
                },
              })
            })
          }
        })()
        configureObservers = new RpcStub(configureObserversTarget)

        overseerStub = authenticatedApi.openGadget(id, shareKey, configureObservers)
        setOverseer({ stub: overseerStub })

        metaSub = await overseerStub.subscribeToMetadata((meta: GadgetMetadata) => {
          if (cancelled) return
          setMetadata(meta)
          if (!isEditingTitleRef.current) setTitleInput(meta.title)
        })

        if (cancelled) return
        setError(null)
        setIsInitialLoad(false)
        if (connectionLost) setConnectionLost(false)
      } catch (err: any) {
        if (cancelled) return
        console.error('Failed to load gadget:', err)

        // TODO: The string-matching here is awful and we need to replace it with something more
        //   structured!
        const msg: string = err?.message ?? ''
        if (msg.includes('Invalid or expired share key')) {
          toasts.add({ title: 'Invalid or expired share link.', variant: 'error' })
        }
        // The user dismissed the observer-config modal — they chose not to connect the accounts
        // this gadget requires. Show a clear, non-alarming explanation rather than a load failure.
        if (msg.includes(OBSERVER_CANCELLED)) {
          setError('To open this Gadget, you must choose connected accounts for the services it uses.')
        }
        // Observer-verification denials carry a specific reason from the overseer; surface it
        // verbatim so the user understands why access was refused.
        else if (msg.includes('permitted to observe') || msg.includes('no longer connected') ||
                 msg.includes('connect an account for every service')) {
          setError(msg)
        }
        // "Not Found" is terminal — the gadget doesn't exist or we're no longer authorized
        // (deliberately indistinguishable). Show the generic error page rather than looping on
        // the reconnecting banner, even mid-session (e.g. after a removed collaborator's session
        // is force-restarted by the backend and they reconnect).
        else if (isInitialLoad || msg.includes('Not Found')) {
          // Not Found intentionally conflates absence and authorization, so it is expected and
          // excluded. Other initial-load failures are unexpected and safe to report by opaque id.
          if (!msg.includes('Not Found')) {
            reportIssue('gadget.load', err, { gadgetId: id })
          }
          setError('Failed to load gadget')
        }
        else if (!connectionLost) setConnectionLost(true)
      }
    }

    load()
    return () => {
      cancelled = true
      // Abort any prompt still awaiting the user, so the server-side open() unwinds cleanly.
      if (pendingObserverRejectRef.current) {
        pendingObserverRejectRef.current(new Error('Cancelled'))
        pendingObserverRejectRef.current = null
      }
      setObserverConfig(null)
      metaSub?.[Symbol.dispose]()
      overseerStub?.[Symbol.dispose]()
      configureObservers?.[Symbol.dispose]()
    }
  }, [id, authenticatedApi, reloadNonce])

  // ── workpiece list subscription ───────────────────────────────────────────────
  useEffect(() => {
    if (!overseer) return
    let sub: RpcStub<{}> | null = null
    let cancelled = false
    const subscriber = new WorkpiecesSubscriberImpl(
      update => setWorkpieces(update),
      initial => {
        setWorkpieces(initial)
        setWorkpiecesReady(true)
      },
    )
    overseer.stub
      .subscribeToWorkpieces(subscriber)
      .then(s => {
        if (cancelled) { s[Symbol.dispose](); return }
        sub = s
      })
      .catch(err => console.error('Failed to subscribe to workpieces:', err))
    return () => {
      cancelled = true
      subscriber.cancel()
      sub?.[Symbol.dispose]()
    }
  }, [overseer])

  // ── selected gadget stub ────────────────────────────────────────────────────────
  // Open a GadgetClient for the selected workpiece. getGadget() pipelines on the overseer stub,
  // so the stub is usable immediately with no extra round trip.
  useEffect(() => {
    if (!overseer || selectedGadgetId === null) {
      setGadget(null)
      return
    }
    const stub = overseer.stub.getGadget(selectedGadgetId)
    setGadget({ id: selectedGadgetId, stub })
    return () => { stub[Symbol.dispose]() }
  }, [overseer, selectedGadgetId])

  // ── follow the agent across gadgets ─────────────────────────────────────────────
  // When the agent starts editing a gadget other than the selected one, switch the picker to it,
  // unless the user picked a workpiece themselves during this turn.
  const userPickedWorkpieceThisTurnRef = useRef(false)
  useEffect(() => {
    userPickedWorkpieceThisTurnRef.current = false
  }, [isAgentActive])

  useEffect(() => {
    const target = streamingActiveFile
    if (target == null || target.workpieceId === selectedGadgetId) return
    if (userPickedWorkpieceThisTurnRef.current) return
    if (!visibleGadgets.some(g => g.id === target.workpieceId)) return
    navigate({
      to: '/gadget/$id',
      params: { id: id! },
      search: (prev: Record<string, unknown>) => ({ ...prev, w: target.workpieceId }),
      replace: true,
    })
  }, [streamingActiveFile, selectedGadgetId, visibleGadgets, navigate, id])

  // ── workpiece picker handlers ───────────────────────────────────────────────────
  const handleSelectWorkpiece = useCallback((workpieceId: WorkpieceId) => {
    if (isAgentActive) userPickedWorkpieceThisTurnRef.current = true
    navigate({
      to: '/gadget/$id',
      params: { id: id! },
      search: (prev: Record<string, unknown>) => ({ ...prev, w: workpieceId }),
    })
  }, [id, navigate, isAgentActive])

  const handleRenameWorkpiece = useCallback(async (workpieceId: WorkpieceId, title: string) => {
    if (!overseer) return
    // The subscription delivers the updated summary, so no local state change is needed.
    const target = overseer.stub.getGadget(workpieceId)
    try {
      await target.setTitle(title)
    } catch {
      toasts.add({ title: 'Failed to rename gadget', variant: 'error' })
    } finally {
      target[Symbol.dispose]()
    }
  }, [overseer, toasts])

  // ── console log subscription ──────────────────────────────────────────────────
  useEffect(() => {
    if (!overseer) return
    let sub: RpcStub<{}> | null = null
    let cancelled = false
    overseer.stub
      .subscribeToConsoleLogs(consoleLogSubscriberRef.current)
      .then(s => {
        if (cancelled) { s[Symbol.dispose](); return }
        sub = s
      })
      .catch(err => console.error('Failed to subscribe to console logs:', err))
    return () => { cancelled = true; sub?.[Symbol.dispose]() }
  }, [overseer])

  // ── reload UI when preview branch/code changes ────────────────────────────────
  useEffect(() => { setUiReloadTrigger(t => t + 1) }, [previewChatId, proposedChanges])

  // ── user info ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    authenticatedApi.whoami().then(setUserInfo).catch(() => {})
  }, [authenticatedApi])

  // ── title save/cancel ─────────────────────────────────────────────────────────
  const handleSaveTitle = async () => {
    if (!overseer || !titleInput.trim()) return
    try {
      await overseer.stub.setTitle(titleInput.trim())
      setMetadata(prev => prev ? { ...prev, title: titleInput.trim() } : null)
      setIsEditingTitle(false)
    } catch { toasts.add({ title: 'Failed to update title', variant: 'error' }) }
  }
  const handleCancelEdit = () => {
    setTitleInput(metadata?.title || '')
    setIsEditingTitle(false)
  }

  // ── back ──────────────────────────────────────────────────────────────────────
  const handleBack = () => {
    navigate({ to: '/' })
  }

  // ── delete ────────────────────────────────────────────────────────────────────
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleDeleteConfirm = async () => {
    if (!overseer) return
    setIsDeleting(true)
    try {
      await overseer.stub.deleteSelf()
      navigate({ to: '/' })
    } catch {
      toasts.add({ title: 'Failed to delete gadget', variant: 'error' })
      setIsDeleting(false)
      setDeleteDialogOpen(false)
    }
  }

  // ── shared height tokens ──────────────────────────────────────────────────────
  const TOPBAR_H = 56   // h-14 (matches home page Header)
  const TABBAR_H = 48   // h-12
  const RIGHT_CONTENT_H = `calc(100vh - ${TOPBAR_H}px - ${TABBAR_H}px)`

  // ── error / loading states ────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-4 bg-kumo-base">
        {/* Observer-verification denials list one line per failed connection, so preserve newlines. */}
        <p className="text-sm text-kumo-danger whitespace-pre-line text-center max-w-lg">{error}</p>
        <div className="flex items-center gap-2">
          <WorkshopButton tone="secondary" onClick={handleBack}>
            Back to home
          </WorkshopButton>
          {/* Offered for every error state, so we don't have to classify the message to decide
              whether a retry could help. */}
          <WorkshopButton tone="primary" onClick={() => setReloadNonce(n => n + 1)}>
            Try again
          </WorkshopButton>
        </div>
      </div>
    )
  }

  // Wait for the workpiece list (and the first selected-gadget stub, which follows it by one
  // effect pass) before rendering; a workspace with no gadgets renders with `gadget` null.
  if (!metadata || !overseer || !workpiecesReady ||
      (selectedGadgetId !== null && gadget === null)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-kumo-base">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-kumo-subtle">Loading gadget…</p>
        </div>
        {observerConfig && (
          <ObserverConfigModal
            needs={observerConfig.needs}
            authenticatedApi={authenticatedApi}
            onConfirm={observerConfig.resolve}
            onCancel={() => observerConfig.reject(new Error(OBSERVER_CANCELLED))}
          />
        )}
      </div>
    )
  }

  // ── "use"-role collaborators get the minimal UI: top bar + gadget iframe only ──
  if (isUseOnly) {
    return (
      <GadgetUseView
        overseer={overseer.stub}
        gadget={selectedGadgetStub}
        selectedGadgetId={selectedGadgetId}
        gadgets={visibleGadgets}
        onSelectGadget={handleSelectWorkpiece}
        metadata={metadata}
        authenticatedApi={authenticatedApi}
        currentUserId={userInfo?.id ?? null}
      />
    )
  }

  // ── always render the full two-pane edit layout; preview overlays on top ──────
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-kumo-base relative">
      {/* ═══ SHARED TOP BAR (visible in both modes) ════════════════════════════ */}
      <div
        className="relative flex items-center justify-between px-4 sm:px-6 backdrop-blur-md border-b border-kumo-line flex-shrink-0 gap-3"
        style={{ height: TOPBAR_H, backgroundColor: 'color-mix(in srgb, var(--color-kumo-base) 80%, transparent)' }}
      >
        <TopBarNotice />
        {/* Left: logo / title */}
        <div className="flex items-center gap-2 min-w-0">
          <Link
            to="/"
            className="flex-shrink-0 hover:opacity-80 transition-opacity"
          >
            <Hexagon size={22} className="text-kumo-brand" weight="bold" />
          </Link>

          <span className="text-kumo-inactive flex-shrink-0">/</span>

          {isEditingTitle ? (
            <div className="flex items-center gap-1">
              <WorkshopInput
                type="text"
                value={titleInput}
                onChange={e => setTitleInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSaveTitle()
                  if (e.key === 'Escape') handleCancelEdit()
                }}
                autoFocus
                className="!h-7 w-56 bg-kumo-tint text-[14px] leading-5 font-medium tracking-[-0.25px]"
              />
              <WorkshopIconButton
                onClick={handleSaveTitle}
                disabled={!titleInput.trim()}
                className="!h-7 !w-7 hover:text-kumo-brand disabled:opacity-30"
                aria-label="Save gadget title"
              >
                <Check size={14} />
              </WorkshopIconButton>
              <WorkshopIconButton
                onClick={handleCancelEdit}
                className="!h-7 !w-7"
                aria-label="Cancel title edit"
              >
                <X size={14} />
              </WorkshopIconButton>
            </div>
          ) : (
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-[14px] leading-5 font-medium tracking-[-0.25px] text-kumo-default truncate">
                {metadata.title}
              </span>
              <WorkshopIconButton
                onClick={() => setIsEditingTitle(true)}
                className="!h-7 !w-7 flex-shrink-0"
                title="Rename gadget"
                aria-label="Rename gadget"
              >
                <Pencil size={16} />
              </WorkshopIconButton>
            </div>
          )}

          {metadata.owner && (
            <span className="text-xs text-kumo-inactive flex-shrink-0">
              by {metadata.owner.name}
            </span>
          )}
        </div>

        {/* Right: presence, cost, workspace, share, blueprints */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <GadgetPresence
            overseer={overseer.stub}
            authenticatedApi={authenticatedApi}
            currentUserId={userInfo?.id ?? null}
          />

          {metadata.totalCost != null && (
            <span className="mr-2 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              {formatHeaderCost(metadata.totalCost)}
            </span>
          )}

          {connectionLost && (
            <span className="text-xs text-kumo-warning px-2 py-0.5 rounded-full bg-kumo-warning-tint border border-kumo-warning/20">
              Reconnecting…
            </span>
          )}

          <WorkshopIconButton
            onClick={() => setWorkspaceVisibility(showFullEditor ? 'closed' : 'open')}
            className="text-kumo-default"
            title={showFullEditor ? 'Hide workspace' : 'Open workspace'}
            aria-label={showFullEditor ? 'Hide workspace' : 'Open workspace'}
            aria-pressed={showFullEditor}
          >
            <span className="relative inline-flex h-3.5 w-4 rounded-sm border border-current/60">
              <span className="absolute inset-y-0 left-1/2 border-l border-current/60" />
              <span
                className={`absolute inset-y-0 right-0 left-1/2 origin-right bg-current/25 transition-transform duration-200 ease-out ${
                  showFullEditor ? 'scale-x-100' : 'scale-x-0'
                }`}
              />
            </span>
          </WorkshopIconButton>

          <WorkshopIconButton
            onClick={() => setShareModalOpen(true)}
            title="Share gadget"
            aria-label="Share gadget"
          >
            <ShareNetwork size={15} />
          </WorkshopIconButton>

          <WorkshopIconButton
            onClick={() => setBlueprintModalOpen(true)}
            disabled={!selectedGadgetStub}
            title="Blueprints"
            aria-label="Blueprints"
          >
            <Blueprint size={16} />
          </WorkshopIconButton>

          {!metadata.owner && (
            <WorkshopIconButton
              danger
              onClick={() => setDeleteDialogOpen(true)}
              title="Delete gadget"
              aria-label="Delete gadget"
            >
              <Trash size={16} />
            </WorkshopIconButton>
          )}

          {/* User menu */}
          <div className="ml-2">
            <UserMenu />
          </div>
        </div>
      </div>

      {/* ═══ BODY ═════════════════════════════════════════════════════════════ */}
      <div className="flex flex-1 min-h-0 relative overflow-hidden">

        {/* Full-width thinking progress bar. */}
        {isAgentActive && (
          <div className="absolute left-0 right-0 h-0 z-10" style={{ top: simpleMode ? 0 : TABBAR_H }}>
            <div className="absolute left-0 right-0 h-0.5 bg-kumo-fill overflow-hidden">
              <div className="absolute inset-y-0 w-1/3 bg-kumo-brand animate-[thinking_1.5s_ease-in-out_infinite]" />
            </div>
          </div>
        )}

        {/* ── LEFT: Chat pane ──────────────────────────────────────────────────── */}
        <div
          className={`flex flex-col flex-shrink-0 ${workspaceTransitionClass} ${showFullEditor ? 'border-r border-kumo-line' : ''}`}
          style={{ width: showFullEditor ? chatWidth : '100%' }}
        >
          {overseer ? (
            <div className="flex-1 min-h-0 relative">
              <div className={layoutModeReady ? 'h-full' : 'h-full invisible'}>
                <ChatInterface
                  key={id}
                  overseer={overseer.stub}
                  selectedChatId={effectiveSelectedChatId}
                  onNavigateToChat={navigateToChat}
                  onProposedChangesChange={setProposedChanges}
                  onDraftProposedChangesChange={setDraftProposedChanges}
                  onStreamingProposedChangesChange={updates => setStreamingProposedChanges(updates)}
                  onStreamingActiveFileChange={setStreamingActiveFile}
                  pendingConsoleLogCount={consoleLogCount}
                  consoleLogPreview={
                    consoleLogCount > 0 ? formatConsoleLogs(consoleLogBufferRef.current) : ''
                  }
                  consoleLogSeverity={
                    consoleLogBufferRef.current.some(l => l.level === 'error')
                      ? 'error'
                      : consoleLogBufferRef.current.some(l => l.level === 'warn')
                      ? 'warn'
                      : 'info'
                  }
                  onConsumeConsoleLogs={consumeConsoleLogs}
                   onDiscardConsoleLogs={discardConsoleLogs}
                   constrainChatWidth={simpleMode}
                   onChatCountChange={handleChatCountChange}
                   onAgentActiveChange={handleAgentActiveChange}
                   onAutoApproveChange={() => setAutoApproveReloadTrigger(t => t + 1)}
                   autoApproveReloadTrigger={autoApproveReloadTrigger}
                   onHasAnyCodeChange={setHasAnyProposedChanges}
                   onSelectedChatHasProposedChangesChange={setSelectedChatHasProposedChanges}
                 />
              </div>

              {!layoutModeReady && (
                <div className="absolute inset-0 flex items-center justify-center bg-kumo-base">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-6 h-6 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
                    <p className="text-sm text-kumo-subtle">Loading conversation…</p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="w-6 h-6 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>

        {/* ── Resize handle ───────────────────────────────────────────────────── */}
        <div
          className={`flex-shrink-0 overflow-visible bg-kumo-line cursor-col-resize relative touch-none ${workspaceTransitionClass}`}
          style={{ width: showFullEditor ? 1 : 0 }}
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
          onPointerCancel={handleResizePointerUp}
        >
          <div className="absolute inset-y-0 -left-2 -right-2" />
        </div>

        {/* ── RIGHT: App / Code / Connections tabs ───────────────────────────── */}
        <div
          className={`flex flex-shrink-0 min-w-0 overflow-hidden bg-kumo-base ${workspaceTransitionClass}`}
          style={{
            width: showFullEditor ? `calc(100% - ${chatWidth}px - 1px)` : 0,
            opacity: showFullEditor ? 1 : 0,
          }}
        >
          {/* Workpiece picker — leftmost column of the panel, only when there's a real choice. */}
          {visibleGadgets.length > 1 && (
            <WorkpiecePicker
              gadgets={visibleGadgets}
              selectedId={selectedGadgetId}
              agentEditingId={streamingActiveFile?.workpieceId ?? null}
              headerHeight={TABBAR_H}
              onSelect={handleSelectWorkpiece}
              onRename={handleRenameWorkpiece}
            />
          )}

          <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          {/* Tab bar */}
          <div
            className="flex items-center px-4 border-b border-kumo-line flex-shrink-0 gap-5"
            style={{ height: TABBAR_H }}
          >
            {RIGHT_TABS.map(tab => (
              <TabButton
                key={tab.value}
                active={activeTab === tab.value}
                onClick={() => setActiveTab(tab.value)}
                badgeCount={tab.value === 'activity' ? pendingActionsCount : 0}
              >
                {tab.label}
              </TabButton>
            ))}
            {activeTab === 'app' && !previewMode && (
              <WorkshopIconButton
                aria-label="Enter full screen"
                title="Full screen"
                onClick={enterGadgetFullscreen}
                className="ml-auto"
              >
                <CornersOut size={16} />
              </WorkshopIconButton>
            )}
          </div>

          {/* Tab content — all kept mounted to preserve state */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <div
              ref={fullscreenOverlayRef}
              tabIndex={isGadgetFullscreen ? -1 : undefined}
              role={isGadgetFullscreen ? 'dialog' : undefined}
              aria-modal={isGadgetFullscreen ? true : undefined}
              aria-label={isGadgetFullscreen ? 'Gadget full screen' : undefined}
              className={
                activeTab !== 'app' || previewMode
                  ? 'hidden'
                  : isGadgetFullscreen
                    ? 'fixed inset-0 z-20 bg-kumo-base outline-none'
                    : 'h-full'
              }
            >
              {selectedGadgetStub && !previewMode ? (
                <GadgetUI
                  key={selectedGadgetId}
                  gadget={selectedGadgetStub}
                  height={isGadgetFullscreen ? '100%' : RIGHT_CONTENT_H}
                  reloadTrigger={uiReloadTrigger}
                  isVisible={activeTab === 'app' && !previewMode}
                  chatId={previewChatId}
                  onConsoleLog={handleClientConsoleLog}
                  onIframeEscape={isGadgetFullscreen ? exitGadgetFullscreen : undefined}
                />
              ) : !previewMode && (
                <NoGadgetPlaceholder height={RIGHT_CONTENT_H} />
              )}
              {isGadgetFullscreen && showFullscreenHint && (
                <div
                  role="status"
                  aria-live="polite"
                  className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 transform"
                >
                  <div className="rounded-full border border-kumo-line bg-kumo-base/90 px-4 py-1.5 text-[13px] leading-[18px] text-kumo-default shadow-md backdrop-blur-sm">
                    Press <kbd className="rounded border border-kumo-line bg-kumo-elevated px-1.5 py-0.5 text-[11px] font-medium">Esc</kbd> to exit full screen
                  </div>
                </div>
              )}
            </div>

            <div className={activeTab === 'code' ? 'h-full' : 'hidden'}>
              {overseer && selectedFilesRoot !== undefined ? (
                <GadgetCodeInterface
                  overseer={overseer.stub}
                  filesRoot={selectedFilesRoot}
                  height={RIGHT_CONTENT_H}
                  onCodeChange={() => setUiReloadTrigger(t => t + 1)}
                  selectedChatId={effectiveSelectedChatId}
                  proposedChanges={proposedChanges}
                  draftProposedChanges={draftProposedChanges}
                  streamingProposedChanges={streamingProposedChanges}
                  streamingActiveFile={streamingActiveFileForSelected}
                  isAgentActive={isAgentActive}
                  isVisible={activeTab === 'code'}
                  onHasCodeChange={setHasCode}
                />
              ) : (
                <NoGadgetPlaceholder height={RIGHT_CONTENT_H} />
              )}
            </div>

            <div className={activeTab === 'connections' ? 'h-full overflow-auto' : 'hidden'}>
              {overseer && selectedGadgetStub ? (
                <Connections
                  key={selectedGadgetId}
                  overseer={overseer.stub}
                  gadget={selectedGadgetStub}
                  chatId={effectiveSelectedChatId ?? undefined}
                  authenticatedApi={authenticatedApi}
                  onConnectionsChange={() => setUiReloadTrigger(t => t + 1)}
                  onAutoApproveChange={() => setAutoApproveReloadTrigger(t => t + 1)}
                  isVisible={activeTab === 'connections'}
                  onHasGatekeepersChange={setHasBindings}
                  reloadTrigger={autoApproveReloadTrigger}
                />
              ) : (
                <NoGadgetPlaceholder height={RIGHT_CONTENT_H} />
              )}
            </div>

            <div className={activeTab === 'activity' ? 'h-full overflow-auto' : 'hidden'}>
              {overseer && hasMountedActivity && (
                <Activity
                  overseer={overseer.stub}
                  onAutoApproveChange={() => setAutoApproveReloadTrigger(t => t + 1)}
                />
              )}
            </div>
          </div>
          </div>
        </div>
      </div>

      {/* ═══ PREVIEW OVERLAY ══════════════════════════════════════════════════ */}
      {previewMode && (
        <div className="absolute inset-x-0 bottom-0 bg-kumo-base z-10" style={{ top: TOPBAR_H }}>
          {selectedGadgetStub && (
            <GadgetUI
              key={selectedGadgetId}
              gadget={selectedGadgetStub}
              height="100%"
              reloadTrigger={uiReloadTrigger}
              isVisible={true}
              chatId={previewChatId}
              onConsoleLog={handleClientConsoleLog}
            />
          )}
        </div>
      )}

      {/* Share modal */}
      {overseer && metadata && (
        <>
          <ShareModal
            open={shareModalOpen}
            onClose={() => setShareModalOpen(false)}
            overseer={overseer.stub}
            metadata={metadata}
            currentUser={userInfo}
            authenticatedApi={authenticatedApi}
          />
          {selectedGadgetStub && (
            <BlueprintModal
              open={blueprintModalOpen}
              onClose={() => setBlueprintModalOpen(false)}
              overseer={overseer.stub}
              gadget={selectedGadgetStub}
              metadata={metadata}
            />
          )}
        </>
      )}

      <DeleteConfirmationDialog
        open={deleteDialogOpen}
        title="Delete gadget?"
        description={<>This removes <span className="font-medium text-kumo-default">{metadata.title}</span>. You can&apos;t undo this.</>}
        isDeleting={isDeleting}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={handleDeleteConfirm}
      />

    </div>
  )
}
