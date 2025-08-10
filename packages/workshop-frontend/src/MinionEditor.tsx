import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Layout, Typography, Button, Input, Space, Card, message } from 'antd'
import { ArrowLeftOutlined, EditOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons'
import { RpcStub } from '@cloudflare/jsrpc'
import { useAuthenticatedApi } from './AuthContext'
import { Overseer, MinionMetadata } from '@minions/workshop-shared/api'

const { Header, Content } = Layout
const { Title, Text } = Typography

export default function MinionEditor() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()
  
  const [overseer, setOverseer] = useState<{ stub: Overseer } | null>(null)
  const [metadata, setMetadata] = useState<MinionMetadata | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleInput, setTitleInput] = useState('')

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

      <Content style={{ padding: '24px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            
            {/* Chat Interface Placeholder */}
            <Card title="AI Agent Chat" style={{ minHeight: 400 }}>
              <div style={{ 
                display: 'flex', 
                justifyContent: 'center', 
                alignItems: 'center', 
                height: 350,
                color: '#999'
              }}>
                <Text type="secondary">
                  Chat interface will be implemented here. Start a conversation with your AI minion.
                </Text>
              </div>
            </Card>

            {/* Code Editor Placeholder */}
            <Card title="Code Editor" style={{ minHeight: 400 }}>
              <div style={{ 
                display: 'flex', 
                justifyContent: 'center', 
                alignItems: 'center', 
                height: 350,
                color: '#999'
              }}>
                <Text type="secondary">
                  Code editor will be implemented here. View and edit your minion's TypeScript code.
                </Text>
              </div>
            </Card>

            {/* Overseer Interface Placeholder */}
            <Card title="Overseer & Connections" style={{ minHeight: 300 }}>
              <div style={{ 
                display: 'flex', 
                justifyContent: 'center', 
                alignItems: 'center', 
                height: 250,
                color: '#999'
              }}>
                <Text type="secondary">
                  Overseer interface will be implemented here. Monitor actions and manage external connections.
                </Text>
              </div>
            </Card>

            {/* Minion UI Placeholder */}
            <Card title="Minion UI" style={{ minHeight: 300 }}>
              <div style={{ 
                display: 'flex', 
                justifyContent: 'center', 
                alignItems: 'center', 
                height: 250,
                color: '#999'
              }}>
                <Text type="secondary">
                  Custom minion UI will be displayed here in a sandboxed iframe when available.
                </Text>
              </div>
            </Card>

          </Space>
        </div>
      </Content>
    </Layout>
  )
}