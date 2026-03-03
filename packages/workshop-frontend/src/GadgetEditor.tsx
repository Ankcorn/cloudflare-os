import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { Layout, Typography, Button, Input, Space, message, Tabs, Modal, Dropdown, Avatar } from 'antd'
import { ArrowLeftOutlined, EditOutlined, CheckOutlined, CloseOutlined, DeleteOutlined, UserOutlined, SettingOutlined, LogoutOutlined, ShareAltOutlined } from '@ant-design/icons'
import { RpcStub, RpcTarget } from 'capnweb'
import { useAuthenticatedApi } from './AuthContext'
import { CF_ACCESS_MODE } from './useAuth'
import AlphaWarning from './AlphaWarning'
import { Overseer, GadgetMetadata, AiChatAuthorInfo, ConsoleLogSubscriber, ConsoleLogEvent } from '@gadgets/workshop-shared/api'
import GadgetCodeInterface from './GadgetCodeInterface'
import GadgetUI from './GadgetUI'
import Connections from './Connections'
import ChatInterface from './ChatInterface'
import ShareModal from './ShareModal'
import type { MenuProps } from 'antd'

const { Header, Content } = Layout
const { Title, Text } = Typography

type BufferedLogEntry = ConsoleLogEvent & { source: 'server' | 'client' }

class ConsoleLogSubscriberImpl extends RpcTarget implements ConsoleLogSubscriber {
  selectedChatIdRef: { current: number | null } = { current: null }
  logBufferRef: { current: BufferedLogEntry[] } = { current: [] }
  onBufferUpdated: () => void = () => {}

  async event(chatId: number | null, logs: ConsoleLogEvent[]) {
    // Always write to the browser console.
    for (const log of logs) {
      const method = console[log.level] ?? console.log
      method("server:", ...log.message)
    }

    // Buffer logs that match the currently-displayed chat.
    if (chatId !== null && chatId === this.selectedChatIdRef.current) {
      this.logBufferRef.current.push(...logs.map(l => ({ ...l, source: 'server' as const })))
      this.onBufferUpdated()
    }
  }
}

function formatConsoleLogs(logs: BufferedLogEntry[]): string {
  const lines = logs.map(log => {
    const parts = log.message.map(part =>
      typeof part === 'string' ? part : JSON.stringify(part)
    )
    return `[${log.source} ${log.level}] ${parts.join(' ')}`
  })
  return 'Console logs:\n' + lines.join('\n')
}

export default function GadgetEditor() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { authenticatedApi, logout } = useAuthenticatedApi()

  // Derive selectedChatId from URL search params
  const chatParam = searchParams.get('chat')
  const urlChatId = chatParam ? Number(chatParam) : null

  const [overseer, setOverseer] = useState<{ stub: RpcStub<Overseer> } | null>(null)
  const [metadata, setMetadata] = useState<GadgetMetadata | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const [connectionLost, setConnectionLost] = useState(false)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const isEditingTitleRef = useRef(false)
  isEditingTitleRef.current = isEditingTitle
  const [titleInput, setTitleInput] = useState('')
  const [siderWidth, setSiderWidth] = useState(() => Math.floor(window.innerWidth / 3))
  const [isResizing, setIsResizing] = useState(false)
  const [uiReloadTrigger, setUiReloadTrigger] = useState(0)
  const [activeTab, setActiveTab] = useState('code')
  const [proposedChanges, setProposedChanges] = useState<Uint8Array | undefined>(undefined)
  const [fileToSelect, setFileToSelect] = useState<string | undefined>(undefined)
  const [userInfo, setUserInfo] = useState<AiChatAuthorInfo | null>(null)
  const [shareModalOpen, setShareModalOpen] = useState(false)

  // Simple chat mode: full-width chat UI when no code, no bindings, and the only chat
  // is chat 0. chatCount starts null (unknown) and is treated as compatible with simple
  // mode so that the UI defaults to simple layout and avoids a flash when opening a new
  // gadget.
  const [hasCode, setHasCode] = useState(false)
  const [chatCount, setChatCount] = useState<number | null>(null)
  const [hasChatZero, setHasChatZero] = useState(false)
  const [hasBindings, setHasBindings] = useState(false)
  // True when the gadget would be in simple mode ignoring proposed changes. Used by
  // the back button to go home even when proposed changes temporarily force complex mode.
  const simpleChatBase = !hasCode && !hasBindings
      && (chatCount === null || (chatCount === 1 && hasChatZero))
  const simpleChatMode = simpleChatBase && proposedChanges === undefined

  // When the gadget would be in simple mode (ignoring proposed changes), always
  // show chat 0 regardless of URL. We use simpleChatBase rather than simpleChatMode
  // so that proposed changes affect only the layout, not the chat selection —
  // otherwise we'd get an infinite loop (proposedChanges toggles simpleChatMode,
  // which toggles selectedChatId, which clears proposedChanges, repeat).
  const selectedChatId = simpleChatBase ? 0 : urlChatId

  const handleChatCountChange = useCallback((count: number, chatZeroExists: boolean) => {
    setChatCount(count)
    setHasChatZero(chatZeroExists)
  }, [])

  // Auto-switch to Gadget UI tab when the agent first generates code on chat 0.
  // Only fires once per gadget to avoid disrupting the user.
  const hasAutoSwitchedToUiRef = useRef(false)
  const hadProposedChangesAtAgentStartRef = useRef(false)
  const proposedChangesRef = useRef(proposedChanges)
  proposedChangesRef.current = proposedChanges
  const handleAgentActiveChange = useCallback((chatId: number, isActive: boolean) => {
    if (chatId !== 0) return
    if (isActive) {
      // Agent just started — record whether proposed changes already exist.
      hadProposedChangesAtAgentStartRef.current = proposedChangesRef.current !== undefined
    } else {
      // Agent just finished — switch to UI tab if this is the first code generation.
      if (
        !hasAutoSwitchedToUiRef.current
        && !hadProposedChangesAtAgentStartRef.current
        && proposedChangesRef.current !== undefined
      ) {
        hasAutoSwitchedToUiRef.current = true
        setActiveTab('ui')
      }
    }
  }, [])

  const navigateToChat = useCallback((chatId: number | null, options?: { replace?: boolean }) => {
    if (chatId !== null) {
      navigate(`/gadget/${id}?chat=${chatId}`, { replace: options?.replace })
    } else {
      navigate(`/gadget/${id}`, { replace: options?.replace })
    }
  }, [navigate, id])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizing) {
        e.preventDefault()
        const newWidth = Math.max(200, Math.min(window.innerWidth - 200, e.clientX))
        setSiderWidth(newWidth)
      }
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }

    if (isResizing) {
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [isResizing])

  useEffect(() => {
    let overseerStub: RpcStub<Overseer> | null = null
    let metadataSubscription: RpcStub<{}> | null = null
    let cancelled = false

    const loadGadget = async () => {
      if (!id) {
        setError('No gadget ID provided')
        return
      }

      // Clear error on initial load
      if (isInitialLoad) {
        setError(null)
      }

      try {
        // Check for a share key in the URL fragment and redeem it as part of opening.
        // The key is placed in the fragment (not a query parameter) so that it is never
        // sent to the server in the HTTP request for the page, never appears in Referer
        // headers, and never ends up in CDN or access logs.
        const hash = window.location.hash // e.g. "#share=abc123"
        const shareKey = hash.startsWith('#share=') ? hash.slice('#share='.length) : undefined
        if (shareKey) {
          // Strip the share key from the URL immediately so it's not visible or re-used.
          window.history.replaceState({}, '', `/gadget/${id}`)
        }

        // Use promise pipelining - use the promise itself as the stub
        overseerStub = authenticatedApi.openGadget(id, shareKey)
        setOverseer({ stub: overseerStub })

        // Subscribe to metadata updates. The callback fires immediately with
        // the current metadata, then again whenever it changes.
        metadataSubscription = await overseerStub.subscribeToMetadata((metadata: GadgetMetadata) => {
          if (cancelled) return
          setMetadata(metadata)
          if (!isEditingTitleRef.current) {
            setTitleInput(metadata.title)
          }
        })

        if (cancelled) return

        // Clear any error on successful load
        setError(null)
        setIsInitialLoad(false)

        // Clear connection lost flag on successful reconnection
        if (connectionLost) {
          setConnectionLost(false)
        }
      } catch (err: any) {
        if (cancelled) return
        console.error('Failed to load gadget:', err)
        const errMsg = err?.message || ''
        if (errMsg.includes('Invalid or expired share key')) {
          message.error('Invalid or expired share link.')
        }
        // Only set error on initial load - for reconnection attempts, keep the UI visible
        if (isInitialLoad) {
          setError('Failed to load gadget')
        } else if (!connectionLost) {
          // Track connection lost state but don't show toast
          setConnectionLost(true)
        }
      }
    }

    loadGadget()

    // Cleanup function to dispose the subscription and overseer stub.
    // The cancelled flag ensures the async loadGadget does not update state
    // after cleanup (important in React Strict Mode, which re-runs effects).
    return () => {
      cancelled = true
      if (metadataSubscription) {
        metadataSubscription[Symbol.dispose]()
      }
      if (overseerStub) {
        overseerStub[Symbol.dispose]()
      }
    }
  }, [id, authenticatedApi])

  // Console log subscription and buffering.
  const consoleLogSubscriberRef = useRef(new ConsoleLogSubscriberImpl())
  const consoleLogBufferRef = useRef<BufferedLogEntry[]>([])
  const [consoleLogCount, setConsoleLogCount] = useState(0)

  // Keep the subscriber wired to the current selectedChatId and buffer.
  const selectedChatIdRef = useRef(selectedChatId)
  selectedChatIdRef.current = selectedChatId
  consoleLogSubscriberRef.current.selectedChatIdRef = selectedChatIdRef
  consoleLogSubscriberRef.current.logBufferRef = consoleLogBufferRef
  consoleLogSubscriberRef.current.onBufferUpdated = () => {
    setConsoleLogCount(consoleLogBufferRef.current.length)
  }

  // Clear the buffer when the selected chat changes.
  useEffect(() => {
    consoleLogBufferRef.current = []
    setConsoleLogCount(0)
  }, [selectedChatId])

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
    // Echo to browser console.
    const method = console[log.level] ?? console.log
    method("client:", ...log.message)

    // Buffer if a chat is selected (client logs always belong to the current chat).
    if (selectedChatIdRef.current !== null) {
      consoleLogBufferRef.current.push({ ...log, source: 'client' as const })
      setConsoleLogCount(consoleLogBufferRef.current.length)
    }
  }, [])

  useEffect(() => {
    if (!overseer) return

    let subscription: RpcStub<{}> | null = null

    const subscribe = async () => {
      try {
        subscription = await overseer.stub.subscribeToConsoleLogs(
          consoleLogSubscriberRef.current
        )
      } catch (err) {
        console.error('Failed to subscribe to console logs:', err)
      }
    }

    subscribe()

    return () => {
      if (subscription) {
        subscription[Symbol.dispose]()
      }
    }
  }, [overseer])

  // Invalidate Gadget UI when the selected chat changes or proposed changes update
  useEffect(() => {
    setUiReloadTrigger(prev => prev + 1)
  }, [selectedChatId, proposedChanges])

  // When the gadget permanently leaves simple mode (e.g. because the AI wrote code
  // and the user merged it), navigate to ?chat=0 so the user stays on the same
  // conversation. We track simpleChatBase (not simpleChatMode) so that proposed
  // changes alone don't trigger navigation — only permanent changes like code,
  // bindings, or additional chats.
  const prevSimpleChatBaseRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (chatCount === null) return
    const prev = prevSimpleChatBaseRef.current
    prevSimpleChatBaseRef.current = simpleChatBase
    if (prev === true && !simpleChatBase && urlChatId === null) {
      navigateToChat(0, { replace: true })
    }
  }, [simpleChatBase, chatCount, urlChatId, navigateToChat])

  useEffect(() => {
    const fetchUserInfo = async () => {
      try {
        const info = await authenticatedApi.whoami()
        setUserInfo(info)
      } catch (error) {
        console.error('Failed to fetch user info:', error)
      }
    }

    fetchUserInfo()
  }, [authenticatedApi])

  const handleSaveTitle = async () => {
    if (!overseer || !titleInput.trim()) {
      return
    }

    try {
      await overseer.stub.setTitle(titleInput.trim())
      setMetadata(prev => prev ? { ...prev, title: titleInput.trim() } : null)
      setIsEditingTitle(false)
      message.success('Title updated successfully')
    } catch (err) {
      console.error('Failed to update title:', err)
      message.error('Failed to update title')
    }
  }

  const handleCancelEdit = () => {
    setTitleInput(metadata?.title || '')
    setIsEditingTitle(false)
  }

  const handleBack = () => {
    if (simpleChatBase) {
      // In simple chat mode (or complex only due to proposed changes), go home.
      navigate('/')
    } else if (selectedChatId !== null) {
      // Push to history so browser back returns to this chat
      navigate(`/gadget/${id}`)
    } else {
      navigate('/')
    }
  }

  const handleCodeChange = () => {
    setUiReloadTrigger(prev => prev + 1)
  }

  const handleFileEdited = (filename: string) => {
    // Set the file to select (user can manually switch to code tab if needed)
    setFileToSelect(filename)
  }

  const handleDelete = () => {
    Modal.confirm({
      title: 'Delete Gadget',
      content: `Are you sure you want to delete "${metadata?.title}"? This action cannot be undone.`,
      okText: 'Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        if (!overseer) return

        try {
          await overseer.stub.deleteSelf()
          message.success('Gadget deleted successfully')
          navigate('/')
        } catch (err) {
          console.error('Failed to delete gadget:', err)
          message.error('Failed to delete gadget')
        }
      }
    })
  }

  const handleLogout = () => {
    logout()
  }

  const accountMenuItems: MenuProps['items'] = [
    {
      key: 'settings',
      label: 'Settings',
      icon: <SettingOutlined />,
      onClick: () => navigate('/settings'),
    },
    ...(!CF_ACCESS_MODE ? [
      { type: 'divider' as const },
      {
        key: 'logout',
        label: 'Logout',
        icon: <LogoutOutlined />,
        onClick: handleLogout,
      },
    ] : []),
  ]

  if (error) {
    return (
      <Layout style={{ minHeight: '100vh' }}>
        <Content style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flexDirection: 'column' }}>
          <Text type="danger" style={{ fontSize: '18px', marginBottom: 16 }}>
            {error}
          </Text>
          <Button onClick={handleBack}>
            Back to Home
          </Button>
        </Content>
      </Layout>
    )
  }

  if (!metadata) {
    return (
      <Layout style={{ minHeight: '100vh' }}>
        <Content style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <Text>Loading gadget...</Text>
        </Content>
      </Layout>
    )
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          backgroundColor: 'white',
          borderBottom: '1px solid #f0f0f0',
          padding: '0 24px',
          display: 'flex',
          alignItems: 'center',
          gap: 16
        }}
      >
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={handleBack}
          type="text"
          size="large"
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {isEditingTitle ? (
            <Space.Compact>
              <Input
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                onPressEnter={handleSaveTitle}
                placeholder="Enter gadget title"
                style={{ width: 300 }}
                autoFocus
              />
              <Button
                icon={<CheckOutlined />}
                onClick={handleSaveTitle}
                type="primary"
                disabled={!titleInput.trim()}
              />
              <Button
                icon={<CloseOutlined />}
                onClick={handleCancelEdit}
              />
            </Space.Compact>
          ) : (
            <>
              <Title level={4} style={{ margin: 0 }}>
                {metadata.title}
              </Title>
              <Button
                icon={<EditOutlined />}
                onClick={() => setIsEditingTitle(true)}
                type="text"
                size="small"
              />
            </>
          )}
        </div>

        <div style={{ flex: 1, textAlign: 'center' }}>
          <AlphaWarning />
        </div>

        <Space>
          {metadata.totalCost != null && (
            <Text style={{ fontSize: '13px', color: '#595959' }}>
              ${metadata.totalCost.toFixed(4)}
            </Text>
          )}
          <Button
            icon={<ShareAltOutlined />}
            onClick={() => setShareModalOpen(true)}
            type="primary"
          >
            Share
          </Button>
          {!metadata.owner && (
            <Button
              icon={<DeleteOutlined />}
              onClick={handleDelete}
              danger
              type="text"
              size="large"
              title="Delete Gadget"
            />
          )}
          <Dropdown menu={{ items: accountMenuItems }} placement="bottomRight" trigger={['click']}>
            <Button type="text" style={{ height: 'auto', padding: '4px 12px' }}>
              <Space>
                <Avatar size="small" icon={<UserOutlined />} />
                <span>{userInfo?.name || 'Account'}</span>
              </Space>
            </Button>
          </Dropdown>
        </Space>
      </Header>

      <div style={{ height: 'calc(100vh - 64px)', display: 'flex' }}>
        {/* Chat - full width in simple mode, sidebar in full mode */}
        <div
          style={{
            ...(simpleChatMode
              ? { flex: 1 }
              : { width: siderWidth, borderRight: '1px solid #f0f0f0' }),
            backgroundColor: 'white',
            height: '100%'
          }}
        >
          {overseer ? (
            <ChatInterface
              overseer={overseer.stub}
              selectedChatId={selectedChatId}
              onNavigateToChat={navigateToChat}
              onProposedChangesChange={setProposedChanges}
              onFileEdited={handleFileEdited}
              pendingConsoleLogCount={consoleLogCount}
              consoleLogPreview={consoleLogCount > 0 ? formatConsoleLogs(consoleLogBufferRef.current) : ''}
              consoleLogSeverity={
                consoleLogBufferRef.current.some(l => l.level === 'error') ? 'error'
                : consoleLogBufferRef.current.some(l => l.level === 'warn') ? 'warn'
                : 'info'
              }
              onConsumeConsoleLogs={consumeConsoleLogs}
              onDiscardConsoleLogs={discardConsoleLogs}
              hideTitleBar={simpleChatMode}
              onChatCountChange={handleChatCountChange}
              onAgentActiveChange={handleAgentActiveChange}
            />
          ) : null}
        </div>

        {/* Resize Handle - hidden in simple chat mode */}
        <div
          style={{
            width: '4px',
            backgroundColor: '#f0f0f0',
            cursor: 'col-resize',
            position: 'relative',
            zIndex: 1,
            ...(simpleChatMode ? { display: 'none' } : {})
          }}
          onMouseDown={() => setIsResizing(true)}
        >
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '16px',
              height: '40px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: '#f0f0f0',
              borderRadius: '4px',
              opacity: 0.7
            }}
          >
            <div style={{
              width: '2px',
              height: '16px',
              backgroundColor: '#999',
              borderRadius: '1px',
              marginRight: '2px'
            }} />
            <div style={{
              width: '2px',
              height: '16px',
              backgroundColor: '#999',
              borderRadius: '1px'
            }} />
          </div>
        </div>

        {/* Main Content with Tabs - hidden in simple chat mode (kept mounted for subscriptions) */}
        <div style={{ backgroundColor: 'white', flex: 1, minWidth: 0, ...(simpleChatMode ? { display: 'none' } : {}) }}>
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            style={{ height: '100%' }}
            tabBarStyle={{ paddingLeft: '16px', marginBottom: 0 }}
            items={[
              {
                key: 'code',
                label: 'Code Editor',
                forceRender: true,
                children: overseer ? (
                  <GadgetCodeInterface
                    overseer={overseer.stub}
                    height="calc(100vh - 64px - 46px)"
                    onCodeChange={handleCodeChange}
                    proposedChanges={proposedChanges}
                    fileToSelect={fileToSelect}
                    onHasCodeChange={setHasCode}
                  />
                ) : null
              },
              {
                key: 'connections',
                label: 'Connections',
                forceRender: true,
                children: overseer ? (
                  <Connections
                    overseer={overseer.stub}
                    authenticatedApi={authenticatedApi}
                    onConnectionsChange={handleCodeChange}
                    isVisible={activeTab === 'connections'}
                    onHasGatekeepersChange={setHasBindings}
                  />
                ) : null
              },
              {
                key: 'ui',
                label: 'Gadget UI',
                children: overseer ? (
                  <GadgetUI
                    overseer={overseer.stub}
                    height="calc(100vh - 64px - 46px)"
                    reloadTrigger={uiReloadTrigger}
                    isVisible={activeTab === 'ui'}
                    chatId={selectedChatId ?? undefined}
                    onConsoleLog={handleClientConsoleLog}
                  />
                ) : null
              }
            ]}
          />
        </div>
      </div>

      {overseer && metadata && (
        <ShareModal
          open={shareModalOpen}
          onClose={() => setShareModalOpen(false)}
          overseer={overseer.stub}
          metadata={metadata}
          currentUser={userInfo}
        />
      )}
    </Layout>
  )
}