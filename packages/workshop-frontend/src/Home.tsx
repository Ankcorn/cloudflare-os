import { Layout, Typography, Button, Table, Space } from 'antd'
import { LogoutOutlined, PlusOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuthenticatedApi } from './AuthContext'
import { useState, useEffect } from 'react'
import { MinionMetadata } from '@minions/workshop-shared/api'

const { Header, Content } = Layout
const { Title, Text } = Typography

export default function Home() {
  const navigate = useNavigate()
  const { authenticatedApi, logout } = useAuthenticatedApi()
  const [minions, setMinions] = useState<MinionMetadata[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchMinions = async () => {
      try {
        const minionList = await authenticatedApi.listMinions()
        setMinions(minionList)
      } catch (error) {
        console.error('Failed to fetch minions:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchMinions()
  }, [authenticatedApi])

  const handleLogout = () => {
    logout()
    // No navigation needed - ProtectedRoute will show login overlay
  }

  const handleCreateMinion = async () => {
    try {
      const newMinion = await authenticatedApi.newMinion()
      const metadata = await newMinion.getMetadata()
      setMinions(prev => [...prev, metadata])
      navigate(`/minion/${metadata.id}`)
    } catch (error) {
      console.error('Failed to create minion:', error)
    }
  }

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
      key: 'lastActive',
      render: () => (
        <Text type="secondary">—</Text>
      ),
    },
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
          Minions Workshop
        </Title>
        <Button
          icon={<LogoutOutlined />}
          onClick={handleLogout}
          type="text"
        >
          Logout
        </Button>
      </Header>

      <Content style={{ padding: '24px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div style={{ 
            marginBottom: 24, 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center' 
          }}>
            <Title level={2} style={{ margin: 0 }}>
              Your Minions
            </Title>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={handleCreateMinion}
              size="large"
            >
              New Minion
            </Button>
          </div>

          <Table
            columns={columns}
            dataSource={minions}
            rowKey="id"
            loading={loading}
            onRow={(record) => ({
              onClick: () => {
                navigate(`/minion/${record.id}`)
              },
              style: { cursor: 'pointer' }
            })}
            locale={{
              emptyText: loading ? 'Loading minions...' : (
                <div style={{ padding: '32px 0' }}>
                  <Text type="secondary">
                    No minions yet. Create your first minion to get started!
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