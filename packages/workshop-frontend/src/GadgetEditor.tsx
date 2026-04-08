import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, useSearch, Link } from '@tanstack/react-router'
import { Dialog, Button, useKumoToastManager } from '@cloudflare/kumo'
import {
  ShareNetwork,
  Pencil,
  Check,
  X,
  Hexagon,
  Trash,
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
import ChatInterface, { type StreamingProposedChanges } from './ChatInterface'
import ShareModal from './ShareModal'

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
    if (chatId !== null && chatId === this.selectedChatIdRef.current) {
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

type RightTab = 'app' | 'code' | 'connections'

const RIGHT_TABS: { value: RightTab; label: string }[] = [
  { value: 'app', label: 'Gadget' },
  { value: 'connections', label: 'Connections' },
  { value: 'code', label: 'Code' },
]

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
  const [chatWidth, setChatWidth] = useState(() => Math.min(420, Math.floor(window.innerWidth * 0.38)))
  const [isResizing, setIsResizing] = useState(false)
  const [activeTab, setActiveTab] = useState<RightTab>('app')
  const [shareModalOpen, setShareModalOpen] = useState(false)
  // Always start in edit mode so the chat sidebar is visible — users interact
  // with the AI even when they are only using the gadget, not editing it.
  const [previewMode, _setPreviewMode] = useState(false)

  // ── code / chat state ────────────────────────────────────────────────────────
  const [uiReloadTrigger, setUiReloadTrigger] = useState(0)
  const [proposedChanges, setProposedChanges] = useState<Uint8Array | undefined>(undefined)
  const [streamingProposedChanges, setStreamingProposedChanges] = useState<StreamingProposedChanges | undefined>(undefined)
  const [fileToSelect, setFileToSelect] = useState<string | undefined>(undefined)
  const [hasCode, setHasCode] = useState<boolean | null>(null)
  const [chatCount, setChatCount] = useState<number | null>(null)
  const [hasChatZero, setHasChatZero] = useState(false)
  const [_hasBindings, setHasBindings] = useState(false)
  const [isAgentActive, setIsAgentActive] = useState(false)
  const [hasAnyProposedChanges, setHasAnyProposedChanges] = useState(false)
  const selectedChatId = urlChatId
  const chatListReady = chatCount !== null
  const codeStateReady = hasCode !== null
  const hasCodeRelatedState = hasCode === true
    || hasAnyProposedChanges
    || streamingProposedChanges !== undefined
  const singleInitialChat = chatCount === 1 && hasChatZero
  const layoutModeReady = chatListReady && (codeStateReady || hasCodeRelatedState)

  // Simple mode: full-width chat layout for a brand-new gadget whose only
  // conversation is chat 0 and which still has no merged or proposed code.
  // We only choose this layout after the initial chat/code subscriptions are
  // ready, so existing gadgets do not briefly flash the wrong UI while loading.
  const simpleMode = layoutModeReady && !hasCodeRelatedState && singleInitialChat
  const showFullEditor = layoutModeReady && !simpleMode

  // When the gadget has only the initial chat, treat chat 0 as selected even if
  // the URL has not caught up yet. This avoids a transient deselect/reselect
  // loop when we transition between simple mode and the full editor.
  const effectiveSelectedChatId = selectedChatId ?? (singleInitialChat ? 0 : null)

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

  const handleClientConsoleLog = useCallback((log: ConsoleLogEvent) => {
    const method = (console as any)[log.level] ?? console.log
    method('client:', ...log.message)
    if (selectedChatIdRef.current !== null) {
      consoleLogBufferRef.current.push({ ...log, source: 'client' as const })
      setConsoleLogCount(consoleLogBufferRef.current.length)
    }
  }, [])

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

  // Auto-switch to the Code tab when the AI starts streaming code for the first
  // time on a fresh gadget. This lets the user watch code being written in
  // real-time. The existing handleAgentActiveChange logic above switches to the
  // Gadget tab once the agent finishes.
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

  // Track whether the user has explicitly navigated back to the list view.
  // This prevents the auto-select effect from immediately re-redirecting them.
  const userNavigatedToListRef = useRef(false)

  useEffect(() => {
    setProposedChanges(undefined)
    setStreamingProposedChanges(undefined)
    setFileToSelect(undefined)
    setHasCode(null)
    setChatCount(null)
    setHasChatZero(false)
    setHasAnyProposedChanges(false)
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

  // ── keep single-chat simple mode URLs clean ─────────────────────────────────
  // When the gadget is in simple mode, chat 0 is implied and we omit it from
  // the URL. In full editor mode, auto-select the only chat on initial load.
  useEffect(() => {
    if (!chatListReady) return

    if (simpleMode) {
      if (urlChatId === 0) {
        navigate({ to: '/gadget/$id', params: { id: id! }, search: {}, replace: true })
      }
      return
    }

    if (urlChatId === null && chatCount === 1 && hasChatZero && !userNavigatedToListRef.current) {
      navigateToChat(0, { replace: true })
    }
  }, [chatListReady, simpleMode, urlChatId, chatCount, hasChatZero, navigateToChat, navigate, id])

  // ── resize handle ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizing) return
      e.preventDefault()
      setChatWidth(Math.max(280, Math.min(window.innerWidth - 400, e.clientX)))
    }
    const onUp = () => {
      setIsResizing(false)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    if (isResizing) {
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
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

  // ── reload UI on chat/proposed changes ────────────────────────────────────────
  useEffect(() => { setUiReloadTrigger(t => t + 1) }, [selectedChatId, proposedChanges])

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
  const TOPBAR_H = 48   // h-12
  const TABBAR_H = 48   // h-12
  const RIGHT_CONTENT_H = `calc(100vh - ${TOPBAR_H}px - ${TABBAR_H}px)`

  // ── error / loading states ────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-4 bg-kumo-base">
        <p className="text-sm text-kumo-danger">{error}</p>
        <button
          onClick={handleBack}
          className="px-4 py-2 text-sm font-medium text-kumo-inverse bg-kumo-brand rounded-lg hover:bg-kumo-brand-hover transition-colors"
        >
          Back to home
        </button>
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
        className="flex items-center justify-between px-4 border-b border-kumo-line flex-shrink-0 gap-3"
        style={{ height: TOPBAR_H, backgroundColor: 'color-mix(in srgb, var(--color-kumo-base) 90%, transparent)' }}
      >
        {/* Left: logo / title */}
        <div className="flex items-center gap-2 min-w-0">
          <Link
            to="/"
            className="flex-shrink-0 hover:opacity-80 transition-opacity"
          >
            <Hexagon size={20} className="text-kumo-brand" weight="bold" />
          </Link>

          <span className="text-kumo-inactive flex-shrink-0">/</span>

          {isEditingTitle ? (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={titleInput}
                onChange={e => setTitleInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSaveTitle()
                  if (e.key === 'Escape') handleCancelEdit()
                }}
                autoFocus
                className="text-sm font-semibold text-kumo-default bg-kumo-tint border border-kumo-brand rounded-md px-2 py-0.5 focus:outline-none w-56"
              />
              <button
                onClick={handleSaveTitle}
                disabled={!titleInput.trim()}
                className="p-1 rounded-md text-kumo-subtle hover:text-kumo-brand hover:bg-kumo-tint transition-colors disabled:opacity-30"
              >
                <Check size={14} />
              </button>
              <button
                onClick={handleCancelEdit}
                className="p-1 rounded-md text-kumo-subtle hover:text-kumo-default hover:bg-kumo-tint transition-colors"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-sm font-semibold text-kumo-default truncate">
                {metadata.title}
              </span>
              <button
                onClick={() => setIsEditingTitle(true)}
                className="p-1.5 text-kumo-subtle hover:text-kumo-default rounded-md hover:bg-kumo-tint transition-colors flex-shrink-0"
                title="Rename gadget"
              >
                <Pencil size={16} />
              </button>
            </div>
          )}

          {metadata.owner && (
            <span className="text-xs text-kumo-inactive flex-shrink-0">
              by {metadata.owner.name}
            </span>
          )}
        </div>

        {/* Right: cost, share, delete */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {metadata.totalCost != null && (
            <span className="text-xs font-mono text-kumo-subtle">
              ${metadata.totalCost.toFixed(4)}
            </span>
          )}

          {connectionLost && (
            <span className="text-xs text-kumo-warning px-2 py-0.5 rounded-full bg-kumo-warning-tint border border-kumo-warning/20">
              Reconnecting…
            </span>
          )}

          <button
            onClick={() => setShareModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium border border-kumo-line rounded-lg text-kumo-default hover:bg-kumo-tint transition-colors"
          >
            <ShareNetwork size={13} />
            Share
          </button>

          {/* Delete gadget */}
          {!metadata.owner && (
            <button
              onClick={() => setDeleteDialogOpen(true)}
              className="p-1.5 text-kumo-subtle hover:text-kumo-danger rounded-md hover:bg-kumo-danger-tint transition-colors"
              title="Delete gadget"
            >
              <Trash size={16} />
            </button>
          )}

          {/* User menu */}
          <div className="ml-1">
            <UserMenu />
          </div>
        </div>
      </div>

      {/* ═══ BODY: always two-pane — chat left, tabs right ════════════════════ */}
      <div className="flex flex-1 min-h-0 relative">

        {/* Full-width thinking progress bar. In simple mode it aligns with the
            top bar border; otherwise it aligns with the tab bar border. */}
        {isAgentActive && (
          <div className="absolute left-0 right-0 h-0 z-10" style={{ top: simpleMode ? 0 : TABBAR_H }}>
            <div className="absolute left-0 right-0 h-0.5 bg-kumo-fill overflow-hidden">
              <div className="absolute inset-y-0 w-1/3 bg-kumo-brand animate-[thinking_1.5s_ease-in-out_infinite]" />
            </div>
          </div>
        )}

        {/* ── LEFT: Chat pane ──────────────────────────────────────────────────── */}
        <div
          className={`flex flex-col ${showFullEditor ? 'border-r border-kumo-line flex-shrink-0' : 'flex-1'}`}
          style={showFullEditor ? { width: chatWidth } : undefined}
        >
          {overseer ? (
            <div className="flex-1 min-h-0 relative">
              <div className={layoutModeReady ? 'h-full' : 'h-full invisible'}>
                <ChatInterface
                  overseer={overseer.stub}
                  selectedChatId={effectiveSelectedChatId}
                  onNavigateToChat={navigateToChat}
                  onProposedChangesChange={setProposedChanges}
                  onStreamingProposedChangesChange={updates => setStreamingProposedChanges(updates)}
                  onFileEdited={setFileToSelect}
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
        {showFullEditor && (
          <div
            className="w-1 flex-shrink-0 bg-kumo-line hover:bg-kumo-brand cursor-col-resize transition-colors relative"
            onMouseDown={() => setIsResizing(true)}
          >
            <div className="absolute inset-y-0 -left-1 -right-1" />
          </div>
        )}

        {/* ── RIGHT: App / Code / Connections tabs ───────────────────────────── */}
        <div className={`flex-1 flex flex-col min-w-0 bg-kumo-base ${showFullEditor ? '' : 'hidden'}`}>
          {/* Tab bar */}
          <div
            className="flex items-center px-4 border-b border-kumo-line flex-shrink-0 gap-1"
            style={{ height: TABBAR_H }}
          >
            {RIGHT_TABS.map(tab => (
              <button
                key={tab.value}
                onClick={() => setActiveTab(tab.value)}
                className={`px-3 py-1.5 text-sm rounded-md transition-colors font-medium ${
                  activeTab === tab.value
                    ? 'bg-kumo-tint text-kumo-default'
                    : 'text-kumo-subtle hover:text-kumo-default hover:bg-kumo-elevated'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content — all kept mounted to preserve state */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <div className={activeTab === 'app' && !previewMode ? 'h-full' : 'hidden'}>
              {overseer && !previewMode && (
                <GadgetUI
                  overseer={overseer.stub}
                  height={RIGHT_CONTENT_H}
                  reloadTrigger={uiReloadTrigger}
                  isVisible={activeTab === 'app' && !previewMode}
                  chatId={selectedChatId ?? undefined}
                  onConsoleLog={handleClientConsoleLog}
                />
              )}
            </div>

            <div className={activeTab === 'code' ? 'h-full' : 'hidden'}>
              {overseer && (
                <GadgetCodeInterface
                  overseer={overseer.stub}
                  height={RIGHT_CONTENT_H}
                  onCodeChange={() => setUiReloadTrigger(t => t + 1)}
                  proposedChanges={proposedChanges}
                  streamingProposedChanges={streamingProposedChanges}
                  fileToSelect={fileToSelect}
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
          </div>
        </div>
      </div>

      {/* ═══ PREVIEW OVERLAY — covers only the body below the shared top bar ══ */}
      {previewMode && (
        <div className="absolute inset-x-0 bottom-0 bg-kumo-base z-10" style={{ top: TOPBAR_H }}>
          {overseer && (
            <GadgetUI
              overseer={overseer.stub}
              height="100%"
              reloadTrigger={uiReloadTrigger}
              isVisible={true}
              chatId={selectedChatId ?? undefined}
              onConsoleLog={handleClientConsoleLog}
            />
          )}
        </div>
      )}

      {/* Share modal */}
      {overseer && metadata && (
        <ShareModal
          open={shareModalOpen}
          onClose={() => setShareModalOpen(false)}
          overseer={overseer.stub}
          metadata={metadata}
          currentUser={userInfo}
        />
      )}

      {/* Delete confirmation dialog */}
      <Dialog.Root
        role="alertdialog"
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
      >
        <Dialog className="p-8" size="sm">
          <Dialog.Title className="text-lg font-semibold">
            Delete gadget
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-kumo-subtle">
            Delete "{metadata?.title}"? This cannot be undone.
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <Button variant="secondary" {...props} disabled={isDeleting}>
                  Cancel
                </Button>
              )}
            />
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              loading={isDeleting}
            >
              Delete
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  )
}
