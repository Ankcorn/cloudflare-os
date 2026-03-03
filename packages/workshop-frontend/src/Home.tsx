import { Layout, Typography, Button, Table, Card, Space, Dropdown, Avatar, Tooltip, Modal, message } from 'antd'
import { DeleteOutlined, LogoutOutlined, UserOutlined, SettingOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuthenticatedApi } from './AuthContext'
import { CF_ACCESS_MODE } from './useAuth'
import AlphaWarning from './AlphaWarning'
import { ChatInput } from './ChatInterface'
import { useState, useEffect, useRef, useCallback } from 'react'
import { GadgetMetadataWithTimestamps, AiChatAuthorInfo, Overseer, CapsuleSpecifier } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import type { MenuProps } from 'antd'

const { Header, Content } = Layout
const { Title, Text } = Typography

function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSeconds < 60) {
    return 'Just now'
  } else if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? '' : 's'} ago`
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`
  } else if (diffDays < 7) {
    return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`
  } else {
    return date.toLocaleDateString()
  }
}

export default function Home() {
  const navigate = useNavigate()
  const { authenticatedApi, logout } = useAuthenticatedApi()
  const [gadgets, setGadgets] = useState<GadgetMetadataWithTimestamps[]>([])
  const [loading, setLoading] = useState(true)
  const [userInfo, setUserInfo] = useState<AiChatAuthorInfo | null>(null)

  useEffect(() => {
    const fetchGadgets = async () => {
      try {
        const gadgetList = await authenticatedApi.listGadgets()
        // Sort by lastActive, most recent first
        gadgetList.sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime())
        setGadgets(gadgetList)
        setLoading(false) // Only set loading to false on successful fetch
      } catch (error) {
        console.error('Failed to fetch gadgets:', error)
        // Keep loading = true when fetch fails, so we show spinner instead of empty state
      }
    }

    fetchGadgets()
  }, [authenticatedApi])

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

  const handleLogout = () => {
    logout()
    // No navigation needed - ProtectedRoute will show login overlay
  }

  const handleDeleteGadget = (gadget: GadgetMetadataWithTimestamps, e: React.MouseEvent) => {
    e.stopPropagation()
    Modal.confirm({
      title: 'Delete Gadget',
      content: `Are you sure you want to delete "${gadget.title}"? This action cannot be undone.`,
      okText: 'Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          const overseer = await authenticatedApi.openGadget(gadget.id)
          try {
            await overseer.deleteSelf()
          } finally {
            overseer[Symbol.dispose]()
          }
          message.success('Gadget deleted')
          setGadgets(prev => prev.filter(g => g.id !== gadget.id))
        } catch (err) {
          console.error('Failed to delete gadget:', err)
          message.error('Failed to delete gadget')
        }
      }
    })
  }

  // --- Provisional gadget management for the home prompt ---
  // These refs track a lazily-created provisional gadget used for capsule creation.
  // Refs (not state) because no re-render is needed when the provisional gadget is created.
  const provisionalGadgetIdRef = useRef<string | null>(null)
  const provisionalOverseerRef = useRef<RpcStub<Overseer> | null>(null)
  // Guard against concurrent provisional gadget creation
  const provisionalGadgetPromiseRef = useRef<Promise<RpcStub<Overseer>> | null>(null)

  // Available models and selection for the home prompt
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [selectedModel, setSelectedModel] = useState<string | null>(null)

  // Fetch models on mount (uses AuthenticatedApi.listModels, no gadget needed)
  useEffect(() => {
    const fetchModels = async () => {
      try {
        const modelList = await authenticatedApi.listModels()
        setModels(modelList)
        // Default model: check localStorage, fall back to first model
        const lastSelected = localStorage.getItem('lastSelectedModel')
        if (lastSelected && modelList.some(m => m.id === lastSelected)) {
          setSelectedModel(lastSelected)
        } else if (modelList.length > 0) {
          setSelectedModel(modelList[0].id)
        }
      } catch (error) {
        console.error('Failed to fetch models:', error)
      }
    }
    fetchModels()
  }, [authenticatedApi])

  // Re-open provisional gadget on RPC reconnection
  useEffect(() => {
    const gadgetId = provisionalGadgetIdRef.current
    if (gadgetId) {
      // Dispose old stub before creating new one
      if (provisionalOverseerRef.current) {
        provisionalOverseerRef.current[Symbol.dispose]()
      }
      // Use promise pipelining: openGadget returns a promise usable as a stub
      provisionalOverseerRef.current = authenticatedApi.openGadget(gadgetId)
    }
  }, [authenticatedApi])

  // Dispose provisional gadget stub on unmount
  useEffect(() => {
    return () => {
      if (provisionalOverseerRef.current) {
        provisionalOverseerRef.current[Symbol.dispose]()
        provisionalOverseerRef.current = null
      }
    }
  }, [])

  // Lazily get or create a provisional gadget. Returns the overseer stub.
  const getProvisionalOverseer = useCallback(async (): Promise<RpcStub<Overseer>> => {
    if (provisionalOverseerRef.current) {
      return provisionalOverseerRef.current
    }
    // Guard against concurrent calls: reuse in-flight promise
    if (provisionalGadgetPromiseRef.current) {
      return provisionalGadgetPromiseRef.current
    }
    const promise = (async () => {
      const overseer = await authenticatedApi.newGadget()
      const metadata = await overseer.getMetadata()
      provisionalGadgetIdRef.current = metadata.id
      provisionalOverseerRef.current = overseer
      provisionalGadgetPromiseRef.current = null
      return overseer
    })()
    provisionalGadgetPromiseRef.current = promise
    return promise
  }, [authenticatedApi])

  // Capsule creation callback for ChatInput: lazily provisions a gadget if needed
  const createCapsuleGatekeeper = useCallback(async (accountId: number, url: string) => {
    const overseer = await getProvisionalOverseer()
    return overseer.newGatekeeper(accountId, url)
  }, [getProvisionalOverseer])

  // Handle sending a message from the home prompt
  const handleHomeSend = useCallback(async (messageText: string, modelId: string | null,
      capsules?: CapsuleSpecifier[]) => {
    const msg = messageText.trim()
    if (!msg) return

    try {
      // Reuse provisional gadget if one was created (e.g. for capsules), otherwise create new
      let overseer = provisionalOverseerRef.current
      let gadgetId = provisionalGadgetIdRef.current
      if (!overseer) {
        overseer = await getProvisionalOverseer()
        gadgetId = provisionalGadgetIdRef.current
      }

      // Create the chat (also marks the gadget as non-provisional)
      const chatId = await overseer.newChat(msg, modelId, capsules)

      // Clear provisional refs -- the gadget is now "real" and we're navigating into it.
      // GadgetEditor will open its own overseer stub; dispose this one.
      overseer[Symbol.dispose]()
      provisionalOverseerRef.current = null
      provisionalGadgetIdRef.current = null
      provisionalGadgetPromiseRef.current = null

      navigate(`/gadget/${gadgetId}?chat=${chatId}`)
    } catch (error) {
      console.error('Failed to create gadget:', error)
      message.error('Failed to start gadget')
    }
  }, [authenticatedApi, getProvisionalOverseer, navigate])

  const handleModelChange = useCallback((modelId: string | null) => {
    setSelectedModel(modelId)
    if (modelId) {
      localStorage.setItem('lastSelectedModel', modelId)
    }
  }, [])

  const columns = [
    {
      title: 'Name',
      dataIndex: 'title',
      key: 'title',
      render: (title: string) => (
        <Text strong>{title}</Text>
      ),
    },
    {
      title: 'Owner',
      key: 'owner',
      render: () => (
        <Text type="secondary">—</Text>
      ),
    },
    {
      title: 'Last Active',
      dataIndex: 'lastActive',
      key: 'lastActive',
      render: (lastActive: Date) => (
        <Tooltip title={lastActive.toLocaleString()}>
          <Text type="secondary">{formatRelativeTime(lastActive)}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'Cost',
      dataIndex: 'totalCost',
      key: 'totalCost',
      render: (totalCost: number | undefined) => (
        <Text style={{ color: '#595959' }}>
          {totalCost != null ? `$${totalCost.toFixed(4)}` : '—'}
        </Text>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 48,
      render: (_: any, record: GadgetMetadataWithTimestamps) => (
        <Button
          type="text"
          size="small"
          danger
          icon={<DeleteOutlined />}
          onClick={(e) => handleDeleteGadget(record, e)}
        />
      ),
    },
  ]

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

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          backgroundColor: 'white',
          borderBottom: '1px solid #f0f0f0',
          padding: '0 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <Title level={4} style={{ margin: 0, color: 'inherit' }}>
          Gadgets Workshop
        </Title>
        <AlphaWarning />
        <Dropdown menu={{ items: accountMenuItems }} placement="bottomRight" trigger={['click']}>
          <Button type="text" style={{ height: 'auto', padding: '4px 12px' }}>
            <Space>
              <Avatar size="small" icon={<UserOutlined />} />
              <span>{userInfo?.name || 'Account'}</span>
            </Space>
          </Button>
        </Dropdown>
      </Header>

      <Content style={{ padding: '24px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          {/* Home prompt: start a new gadget by typing a message */}
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '32px' }}>
            <div style={{ width: '100%', maxWidth: '600px' }}>
              <Card>
                <Title level={4} style={{ margin: '0 0 16px', textAlign: 'center' }}>
                  What would you like to build?
                </Title>
                <ChatInput
                  createCapsuleGatekeeper={createCapsuleGatekeeper}
                  getOverseer={getProvisionalOverseer}
                  onSend={handleHomeSend}
                  isAgentActive={false}
                  models={models}
                  selectedModel={selectedModel}
                  onModelChange={handleModelChange}
                  newChat
                />
              </Card>
            </div>
          </div>

          <Title level={4} style={{ margin: '0 0 16px' }}>
            Your Gadgets
          </Title>

          <Table
            columns={columns}
            dataSource={gadgets}
            rowKey="id"
            loading={loading}
            pagination={{ pageSize: 50 }}
            onRow={(record) => ({
              onClick: () => {
                navigate(`/gadget/${record.id}`)
              },
              style: { cursor: 'pointer' }
            })}
            locale={{
              emptyText: loading ? 'Loading gadgets...' : (
                <div style={{ padding: '32px 0' }}>
                  <Text type="secondary">
                    No gadgets yet. Describe what you want to build above to get started!
                  </Text>
                </div>
              )
            }}
          />
        </div>
      </Content>
    </Layout>
  )
}