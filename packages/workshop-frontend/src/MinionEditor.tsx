import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Layout, Typography, Button, Input, Space, Card, message, Tabs, Modal, Dropdown, Avatar } from 'antd'
import { ArrowLeftOutlined, EditOutlined, CheckOutlined, CloseOutlined, DeleteOutlined, UserOutlined, SettingOutlined, LogoutOutlined } from '@ant-design/icons'
import { RpcStub } from 'capnweb'
import { useAuthenticatedApi } from './AuthContext'
import { Overseer, MinionMetadata, AiChatAuthorInfo } from '@minions/workshop-shared/api'
import MinionCodeInterface from './MinionCodeInterface'
import MinionUI from './MinionUI'
import Connections from './Connections'
import ChatInterface from './ChatInterface'
import type { MenuProps } from 'antd'

const { Header, Content } = Layout
const { Title, Text } = Typography

export default function MinionEditor() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { authenticatedApi, logout } = useAuthenticatedApi()

  const [overseer, setOverseer] = useState<{ stub: RpcStub<Overseer> } | null>(null)
  const [metadata, setMetadata] = useState<MinionMetadata | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const [connectionLost, setConnectionLost] = useState(false)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleInput, setTitleInput] = useState('')
  const [siderWidth, setSiderWidth] = useState(() => Math.floor(window.innerWidth / 3))
  const [isResizing, setIsResizing] = useState(false)
  const [uiReloadTrigger, setUiReloadTrigger] = useState(0)
  const [activeTab, setActiveTab] = useState('code')
  const [proposedChanges, setProposedChanges] = useState<Uint8Array | undefined>(undefined)
  const [fileToSelect, setFileToSelect] = useState<string | undefined>(undefined)
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null)
  const [userInfo, setUserInfo] = useState<AiChatAuthorInfo | null>(null)

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

    const loadMinion = async () => {
      if (!id) {
        setError('No minion ID provided')
        setLoading(false)
        return
      }

      // Only show loading/clear error on initial load
      if (isInitialLoad) {
        setError(null)
        setLoading(true)
      }

      try {
        // Use promise pipelining - use the promise itself as the stub
        overseerStub = authenticatedApi.openMinion(id)
        setOverseer({ stub: overseerStub })

        // Only await the metadata call
        const minionMetadata = await overseerStub.getMetadata()
        setMetadata(minionMetadata)
        setTitleInput(minionMetadata.title)

        // Clear any error on successful load
        setError(null)
        setIsInitialLoad(false)

        // Clear connection lost flag on successful reconnection
        if (connectionLost) {
          setConnectionLost(false)
        }
      } catch (err) {
        console.error('Failed to load minion:', err)
        // Only set error on initial load - for reconnection attempts, keep the UI visible
        if (isInitialLoad) {
          setError('Failed to load minion')
        } else if (!connectionLost) {
          // Track connection lost state but don't show toast
          setConnectionLost(true)
        }
      } finally {
        if (isInitialLoad) {
          setLoading(false)
        }
      }
    }

    loadMinion()

    // Cleanup function to dispose the correct stub
    return () => {
      if (overseerStub) {
        overseerStub[Symbol.dispose]()
      }
    }
  }, [id, authenticatedApi])

  // Invalidate Minion UI when the selected chat changes or proposed changes update
  useEffect(() => {
    setUiReloadTrigger(prev => prev + 1)
  }, [selectedChatId, proposedChanges])

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
    navigate('/')
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
      title: 'Delete Minion',
      content: `Are you sure you want to delete "${metadata?.title}"? This action cannot be undone.`,
      okText: 'Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        if (!overseer) return

        try {
          await overseer.stub.deleteSelf()
          message.success('Minion deleted successfully')
          navigate('/')
        } catch (err) {
          console.error('Failed to delete minion:', err)
          message.error('Failed to delete minion')
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
    {
      type: 'divider',
    },
    {
      key: 'logout',
      label: 'Logout',
      icon: <LogoutOutlined />,
      onClick: handleLogout,
    },
  ]

  if (loading) {
    return (
      <Layout style={{ minHeight: '100vh' }}>
        <Content style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <Text>Loading minion...</Text>
        </Content>
      </Layout>
    )
  }

  if (error || !metadata) {
    return (
      <Layout style={{ minHeight: '100vh' }}>
        <Content style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flexDirection: 'column' }}>
          <Text type="danger" style={{ fontSize: '18px', marginBottom: 16 }}>
            {error || 'Failed to load minion'}
          </Text>
          <Button onClick={handleBack}>
            Back to Home
          </Button>
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

        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12 }}>
          {isEditingTitle ? (
            <Space.Compact>
              <Input
                value={titleInput}
                onChange={(e) => setTitleInput(e.target.value)}
                onPressEnter={handleSaveTitle}
                placeholder="Enter minion title"
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

        <Space>
          <Button
            icon={<DeleteOutlined />}
            onClick={handleDelete}
            danger
            type="text"
            size="large"
            title="Delete Minion"
          />
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
        {/* Chat Sidebar */}
        <div
          style={{
            width: siderWidth,
            backgroundColor: 'white',
            borderRight: '1px solid #f0f0f0',
            height: '100%'
          }}
        >
          {overseer ? (
            <ChatInterface
              overseer={overseer.stub}
              onProposedChangesChange={setProposedChanges}
              onFileEdited={handleFileEdited}
              onSelectedChatChange={setSelectedChatId}
            />
          ) : null}
        </div>

        {/* Resize Handle */}
        <div
          style={{
            width: '4px',
            backgroundColor: '#f0f0f0',
            cursor: 'col-resize',
            position: 'relative',
            zIndex: 1
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

        {/* Main Content with Tabs */}
        <div style={{ backgroundColor: 'white', flex: 1, minWidth: 0 }}>
          <Tabs
            activeKey={activeTab}
            onChange={setActiveTab}
            style={{ height: '100%' }}
            tabBarStyle={{ paddingLeft: '16px', marginBottom: 0 }}
            items={[
              {
                key: 'code',
                label: 'Code Editor',
                children: overseer ? (
                  <MinionCodeInterface
                    overseer={overseer.stub}
                    height="calc(100vh - 64px - 46px)"
                    onCodeChange={handleCodeChange}
                    proposedChanges={proposedChanges}
                    fileToSelect={fileToSelect}
                  />
                ) : null
              },
              {
                key: 'connections',
                label: 'Connections',
                children: overseer ? (
                  <Connections
                    overseer={overseer.stub}
                    onConnectionsChange={handleCodeChange}
                    isVisible={activeTab === 'connections'}
                  />
                ) : null
              },
              {
                key: 'ui',
                label: 'Minion UI',
                children: overseer ? (
                  <MinionUI
                    overseer={overseer.stub}
                    height="calc(100vh - 64px - 46px)"
                    reloadTrigger={uiReloadTrigger}
                    isVisible={activeTab === 'ui'}
                    chatId={selectedChatId ?? undefined}
                  />
                ) : null
              }
            ]}
          />
        </div>
      </div>
    </Layout>
  )
}