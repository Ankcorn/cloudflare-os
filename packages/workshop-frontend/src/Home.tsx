import { Layout, Typography, Button, Table, Space, Dropdown, Avatar } from 'antd'
import { LogoutOutlined, PlusOutlined, UserOutlined, SettingOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuthenticatedApi } from './AuthContext'
import { useState, useEffect } from 'react'
import { MinionMetadata, AiChatAuthorInfo } from '@minions/workshop-shared/api'
import type { MenuProps } from 'antd'

const { Header, Content } = Layout
const { Title, Text } = Typography

export default function Home() {
  const navigate = useNavigate()
  const { authenticatedApi, logout } = useAuthenticatedApi()
  const [minions, setMinions] = useState<MinionMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [userInfo, setUserInfo] = useState<AiChatAuthorInfo | null>(null)

  useEffect(() => {
    const fetchMinions = async () => {
      try {
        const minionList = await authenticatedApi.listMinions()
        setMinions(minionList)
        setLoading(false) // Only set loading to false on successful fetch
      } catch (error) {
        console.error('Failed to fetch minions:', error)
        // Keep loading = true when fetch fails, so we show spinner instead of empty state
      }
    }

    fetchMinions()
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
            pagination={{ pageSize: 50 }}
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