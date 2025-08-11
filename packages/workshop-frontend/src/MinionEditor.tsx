import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Layout, Typography, Button, Input, Space, Card, message, Tabs } from 'antd'
import { ArrowLeftOutlined, EditOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons'
import { RpcStub } from '@cloudflare/jsrpc'
import { useAuthenticatedApi } from './AuthContext'
import { Overseer, MinionMetadata } from '@minions/workshop-shared/api'
import MinionCodeInterface from './MinionCodeInterface'

const { Header, Content } = Layout
const { Title, Text } = Typography

export default function MinionEditor() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()

  const [overseer, setOverseer] = useState<{ stub: RpcStub<Overseer> } | null>(null)
  const [metadata, setMetadata] = useState<MinionMetadata | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleInput, setTitleInput] = useState('')
  const [siderWidth, setSiderWidth] = useState(() => Math.floor(window.innerWidth / 3))
  const [isResizing, setIsResizing] = useState(false)

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizing) {
        e.preventDefault()
        const newWidth = Math.max(200, Math.min(800, e.clientX))
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

      try {
        // Use promise pipelining - use the promise itself as the stub
        overseerStub = authenticatedApi.openMinion(id)
        setOverseer({ stub: overseerStub })

        // Only await the metadata call
        const minionMetadata = await overseerStub.getMetadata()
        setMetadata(minionMetadata)
        setTitleInput(minionMetadata.title)
      } catch (err) {
        console.error('Failed to load minion:', err)
        setError('Failed to load minion')
      } finally {
        setLoading(false)
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
      </Header>

      <div style={{ height: 'calc(100vh - 64px)', display: 'flex' }}>
        {/* Chat Sidebar */}
        <div
          style={{
            width: siderWidth,
            backgroundColor: 'white',
            borderRight: '1px solid #f0f0f0'
          }}
        >
          <Card
            title="AI Agent Chat"
            variant="borderless"
            style={{
              height: '100%',
              display: 'flex',
              flexDirection: 'column'
            }}
            styles={{
              body: {
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                padding: '16px'
              }
            }}
          >
            <div style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              flex: 1,
              color: '#999'
            }}>
              <Text type="secondary">
                Chat interface will be implemented here. Start a conversation with your AI minion.
              </Text>
            </div>
          </Card>
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
        <div style={{ backgroundColor: 'white', flex: 1 }}>
          <Tabs
            defaultActiveKey="code"
            style={{ height: '100%' }}
            tabBarStyle={{ paddingLeft: '16px' }}
            items={[
              {
                key: 'code',
                label: 'Code Editor',
                children: overseer ? (
                  <MinionCodeInterface
                    overseer={overseer.stub}
                    height="calc(100vh - 64px - 46px)"
                  />
                ) : null
              },
              {
                key: 'overseer',
                label: 'Overseer & Connections',
                children: (
                  <div style={{
                    height: 'calc(100vh - 64px - 46px)', // Full height minus header and tab bar
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    color: '#999'
                  }}>
                    <Text type="secondary">
                      Overseer interface will be implemented here. Monitor actions and manage external connections.
                    </Text>
                  </div>
                )
              },
              {
                key: 'ui',
                label: 'Minion UI',
                children: (
                  <div style={{
                    height: 'calc(100vh - 64px - 46px)', // Full height minus header and tab bar
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    color: '#999'
                  }}>
                    <Text type="secondary">
                      Custom minion UI will be displayed here in a sandboxed iframe when available.
                    </Text>
                  </div>
                )
              }
            ]}
          />
        </div>
      </div>
    </Layout>
  )
}