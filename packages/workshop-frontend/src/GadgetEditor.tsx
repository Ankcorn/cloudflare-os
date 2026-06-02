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

import {
  Overseer,
  GadgetMetadata,
  AiChatAuthorInfo,
  ConsoleLogSubscriber,
  ConsoleLogEvent,
} from '@gadgets/workshop-shared/api'
import GadgetCodeInterface from './GadgetCodeInterface'
import GadgetUI from './GadgetUI'
import Connections from './Connections'
import Activity from './Activity'
import ChatInterface, { type StreamingProposedChanges } from './ChatInterface'
import ShareModal from './ShareModal'
import BlueprintModal from './BlueprintModal'
import AlphaWarning from './AlphaWarning'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from './components/WorkshopControls'
import { TabButton } from './components/TabButton'
import { useActions } from './useActions'
import DeleteConfirmationDialog from './components/DeleteConfirmationDialog'
import { formatDocumentTitle, useDocumentTitle } from './useDocumentTitle'

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

// ─── component ────────────────────────────────────────────────────────────────

export default function GadgetEditor() {
  const params = useParams({ strict: false }) as { id?: string }
  const id = params.id
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()

  const { chat: chatParam } = useSearch({ strict: false }) as { chat?: number }
  const urlChatId = chatParam !== undefined ? chatParam : null

  // ── toasts ─────────────────────────────────────────────────────────────────────
  const toasts = useKumoToastManager()

  // ── core state ──────────────────────────────────────────────────────────────
  const [overseer, setOverseer] = useState<{ stub: RpcStub<Overseer> } | null>(null)
  const [metadata, setMetadata] = useState<GadgetMetadata | null>(null)
  useDocumentTitle(metadata ? formatDocumentTitle(metadata.title) : undefined)
  const [error, setError] = useState<string | null>(null)
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const [connectionLost, setConnectionLost] = useState(false)
  const [userInfo, setUserInfo] = useState<AiChatAuthorInfo | null>(null)
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
  const [workspaceOverride, setWorkspaceOverride] = useState<WorkspaceOverride>(null)
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
  const [proposedChanges, setProposedChanges] = useState<Uint8Array | undefined>(undefined)
  const [draftProposedChanges, setDraftProposedChanges] = useState<StreamingProposedChanges | undefined>(undefined)
  const [streamingProposedChanges, setStreamingProposedChanges] = useState<StreamingProposedChanges | undefined>(undefined)
  const [streamingActiveFile, setStreamingActiveFile] = useState<string | null | undefined>(undefined)
  const [hasCode, setHasCode] = useState<boolean | null>(null)
  const [chatCount, setChatCount] = useState<number | null>(null)
  const [hasChatZero, setHasChatZero] = useState(false)
  const [_hasBindings, setHasBindings] = useState(false)
  const [isAgentActive, setIsAgentActive] = useState(false)
  const [hasAnyProposedChanges, setHasAnyProposedChanges] = useState(false)
  const [selectedChatHasProposedChanges, setSelectedChatHasProposedChanges] = useState(false)
  const selectedChatId = urlChatId
  const chatListReady = chatCount !== null
  const codeStateReady = hasCode !== null
  const hasCodeRelatedState = hasCode === true
    || hasAnyProposedChanges
    || streamingProposedChanges !== undefined
  const singleInitialChat = chatCount === 1 && hasChatZero
  const layoutModeReady = chatListReady && (codeStateReady || hasCodeRelatedState)
  const pinInitialChatSelection = singleInitialChat && hasCode !== true

  // Simple mode: full-width chat layout for a brand-new gadget whose only
  // conversation is chat 0 and which still has no merged or proposed code.
  // We only choose this layout after the initial chat/code subscriptions are
  // ready, so existing gadgets do not briefly flash the wrong UI while loading.
  const simpleMode = layoutModeReady && !hasCodeRelatedState && singleInitialChat
  const showFullEditor = layoutModeReady && (
    workspaceOverride === null ? !simpleMode : workspaceOverride === 'open'
  )
  const workspaceTransitionClass = workspaceTransitionEnabled && !isResizing
    ? 'transition-[width,opacity] duration-200 ease-out'
    : ''

  // Before any code has been merged, a single-thread gadget conceptually only
  // has one useful conversation, so keep chat 0 selected even if the URL has
  // not caught up yet. As soon as merged code exists, dropping back to the chat
  // list should become possible.
  const effectiveSelectedChatId = selectedChatId ?? (pinInitialChatSelection ? 0 : null)
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
  const proposedChangesRef = useRef(proposedChanges)
  proposedChangesRef.current = proposedChanges

  const handleAgentActiveChange = useCallback((chatId: number, isActive: boolean) => {
    setIsAgentActive(isActive)
    if (chatId !== 0) return
    if (isActive) {
      hadProposedChangesAtAgentStartRef.current = proposedChangesRef.current !== undefined
    } else {
      if (
        !hasAutoSwitchedToUiRef.current &&
        !hadProposedChangesAtAgentStartRef.current &&
        proposedChangesRef.current !== undefined
      ) {
        hasAutoSwitchedToUiRef.current = true
        setActiveTab('app')
      }
    }
  }, [])

  // Show the Code tab while a fresh gadget's first files are being written.
  useEffect(() => {
    if (
      streamingProposedChanges !== undefined &&
      !hasAutoSwitchedToCodeRef.current &&
      !hasCode
    ) {
      hasAutoSwitchedToCodeRef.current = true
      setActiveTab('code')
    }
  }, [streamingProposedChanges, hasCode])

  const userNavigatedToListRef = useRef(false)

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
    setWorkspaceOverride(null)
    setWorkspaceTransitionEnabled(false)
    setHasMountedActivity(false)
    hasAutoSwitchedToCodeRef.current = false
    hasAutoSwitchedToUiRef.current = false
    hadProposedChangesAtAgentStartRef.current = false
    userNavigatedToListRef.current = false
  }, [id])

  // ── navigation helper ────────────────────────────────────────────────────────
  const navigateToChat = useCallback(
    (chatId: number | null, options?: { replace?: boolean }) => {
      if (chatId === null) userNavigatedToListRef.current = true
      else userNavigatedToListRef.current = false
      navigate({
        to: '/gadget/$id',
        params: { id: id! },
        search: chatId !== null ? { chat: chatId } : {},
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
        navigate({ to: '/gadget/$id', params: { id: id! }, search: {}, replace: true })
      }
      return
    }

    if (pinInitialChatSelection && urlChatId === null && !userNavigatedToListRef.current) {
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
    let cancelled = false

    const load = async () => {
      if (!id) { setError('No gadget ID provided'); return }
      if (isInitialLoad) setError(null)

      try {
        const hash = window.location.hash
        const shareKey = hash.startsWith('#share=') ? hash.slice('#share='.length) : undefined
        if (shareKey) navigate({ to: '/gadget/$id', params: { id: id! }, search: {}, replace: true })

        overseerStub = authenticatedApi.openGadget(id, shareKey)
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
        if (err?.message?.includes('Invalid or expired share key')) {
          toasts.add({ title: 'Invalid or expired share link.', variant: 'error' })
        }
        if (isInitialLoad) setError('Failed to load gadget')
        else if (!connectionLost) setConnectionLost(true)
      }
    }

    load()
    return () => {
      cancelled = true
      metaSub?.[Symbol.dispose]()
      overseerStub?.[Symbol.dispose]()
    }
  }, [id, authenticatedApi])

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
        <p className="text-sm text-kumo-danger">{error}</p>
        <WorkshopButton
          tone="primary"
          onClick={handleBack}
        >
          Back to home
        </WorkshopButton>
      </div>
    )
  }

  if (!metadata) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-kumo-base">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-kumo-subtle">Loading gadget…</p>
        </div>
      </div>
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
        <AlphaWarning />
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

        {/* Right: cost, workspace, share, blueprints */}
        <div className="flex items-center gap-1 flex-shrink-0">
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
            onClick={() => {
              setWorkspaceTransitionEnabled(true)
              setWorkspaceOverride(showFullEditor ? 'closed' : 'open')
            }}
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
                   hideTitleBar={simpleMode}
                   constrainChatWidth={simpleMode}
                   onChatCountChange={handleChatCountChange}
                   onAgentActiveChange={handleAgentActiveChange}
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
          className={`flex flex-col flex-shrink-0 min-w-0 overflow-hidden bg-kumo-base ${workspaceTransitionClass}`}
          style={{
            width: showFullEditor ? `calc(100% - ${chatWidth}px - 1px)` : 0,
            opacity: showFullEditor ? 1 : 0,
          }}
        >
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
              {overseer && !previewMode && (
                <GadgetUI
                  overseer={overseer.stub}
                  height={isGadgetFullscreen ? '100%' : RIGHT_CONTENT_H}
                  reloadTrigger={uiReloadTrigger}
                  isVisible={activeTab === 'app' && !previewMode}
                  chatId={previewChatId}
                  onConsoleLog={handleClientConsoleLog}
                  onIframeEscape={isGadgetFullscreen ? exitGadgetFullscreen : undefined}
                />
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
              {overseer && (
                <GadgetCodeInterface
                  overseer={overseer.stub}
                  height={RIGHT_CONTENT_H}
                  onCodeChange={() => setUiReloadTrigger(t => t + 1)}
                  selectedChatId={effectiveSelectedChatId}
                  proposedChanges={proposedChanges}
                  draftProposedChanges={draftProposedChanges}
                  streamingProposedChanges={streamingProposedChanges}
                  streamingActiveFile={streamingActiveFile}
                  isAgentActive={isAgentActive}
                  isVisible={activeTab === 'code'}
                  onHasCodeChange={setHasCode}
                />
              )}
            </div>

            <div className={activeTab === 'connections' ? 'h-full overflow-auto' : 'hidden'}>
              {overseer && (
                <Connections
                  overseer={overseer.stub}
                  authenticatedApi={authenticatedApi}
                  onConnectionsChange={() => setUiReloadTrigger(t => t + 1)}
                  isVisible={activeTab === 'connections'}
                  onHasGatekeepersChange={setHasBindings}
                />
              )}
            </div>

            <div className={activeTab === 'activity' ? 'h-full overflow-auto' : 'hidden'}>
              {overseer && hasMountedActivity && (
                <Activity
                  overseer={overseer.stub}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ═══ PREVIEW OVERLAY ══════════════════════════════════════════════════ */}
      {previewMode && (
        <div className="absolute inset-x-0 bottom-0 bg-kumo-base z-10" style={{ top: TOPBAR_H }}>
          {overseer && (
            <GadgetUI
              overseer={overseer.stub}
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
          />
          <BlueprintModal
            open={blueprintModalOpen}
            onClose={() => setBlueprintModalOpen(false)}
            overseer={overseer.stub}
            metadata={metadata}
          />
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
