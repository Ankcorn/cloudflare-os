import { Layout, Typography, Button, Space, Input, Avatar, Table, Modal, message, Card, Select } from 'antd'
import { ArrowLeftOutlined, EditOutlined, CheckOutlined, CloseOutlined, UserOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useAuthenticatedApi } from './AuthContext'
import { useState, useEffect } from 'react'
import { AiChatAuthorInfo } from '@minions/workshop-shared/api'
import AddModelModal from './AddModelModal'

const { Header, Content } = Layout
const { Title, Text } = Typography

export default function SettingsPage() {
  const navigate = useNavigate()
  const { authenticatedApi } = useAuthenticatedApi()
  const [userInfo, setUserInfo] = useState<AiChatAuthorInfo | null>(null)
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [modelsLoading, setModelsLoading] = useState(true)
  const [isEditingName, setIsEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [addModalVisible, setAddModalVisible] = useState(false)
  const [quickModel, setQuickModel] = useState<string | null>(null)
  const [quickModelLoading, setQuickModelLoading] = useState(true)

  // Fetch user info
  useEffect(() => {
    const fetchUserInfo = async () => {
      try {
        const info = await authenticatedApi.whoami()
        setUserInfo(info)
        setNameInput(info.name)
        setLoading(false)
      } catch (error) {
        console.error('Failed to fetch user info:', error)
        message.error('Failed to load user information')
        setLoading(false)
      }
    }

    fetchUserInfo()
  }, [authenticatedApi])

  // Fetch models
  const fetchModels = async () => {
    setModelsLoading(true)
    try {
      const modelList = await authenticatedApi.listModels()
      setModels(modelList)
    } catch (error) {
      console.error('Failed to fetch models:', error)
      message.error('Failed to load AI models')
    } finally {
      setModelsLoading(false)
    }
  }

  useEffect(() => {
    fetchModels()
  }, [authenticatedApi])

  // Fetch quick model setting
  useEffect(() => {
    const fetchQuickModel = async () => {
      try {
        const quickModelId = await authenticatedApi.getQuickModel()
        setQuickModel(quickModelId)
      } catch (error) {
        console.error('Failed to fetch quick model:', error)
      } finally {
        setQuickModelLoading(false)
      }
    }

    fetchQuickModel()
  }, [authenticatedApi])

  const handleQuickModelChange = async (value: string | null) => {
    const previousValue = quickModel
    setQuickModel(value)
    try {
      await authenticatedApi.setQuickModel(value)
      message.success('Quick model updated')
    } catch (err) {
      console.error('Failed to update quick model:', err)
      message.error('Failed to update quick model')
      setQuickModel(previousValue) // Revert on error
    }
  }

  const handleSaveName = async () => {
    if (!nameInput.trim()) {
      message.error('Display name cannot be empty')
      return
    }

    try {
      await authenticatedApi.setOwnDisplayName(nameInput.trim())
      setUserInfo(prev => prev ? { ...prev, name: nameInput.trim() } : null)
      setIsEditingName(false)
      message.success('Display name updated successfully')
    } catch (err) {
      console.error('Failed to update display name:', err)
      message.error('Failed to update display name')
    }
  }

  const handleCancelEdit = () => {
    setNameInput(userInfo?.name || '')
    setIsEditingName(false)
  }

  const handleDeleteModel = (modelId: string, modelName: string) => {
    Modal.confirm({
      title: 'Delete AI Model',
      content: `Are you sure you want to delete "${modelName}"? This action cannot be undone.`,
      okText: 'Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          await authenticatedApi.deleteModel(modelId)
          message.success('AI model deleted successfully')
          fetchModels()
        } catch (err) {
          console.error('Failed to delete model:', err)
          message.error('Failed to delete model')
        }
      }
    })
  }

  const handleBack = () => {
    navigate('/')
  }

  const modelColumns = [
    {
      title: 'Display Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: 'Model ID',
      dataIndex: 'id',
      key: 'id',
      render: (id: string) => <Text type="secondary">{id}</Text>,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 100,
      render: (_: any, record: AiChatAuthorInfo) => (
        <Button
          icon={<DeleteOutlined />}
          onClick={() => handleDeleteModel(record.id, record.name)}
          danger
          type="text"
        />
      ),
    },
  ]

  if (loading) {
    return (
      <Layout style={{ minHeight: '100vh' }}>
        <Content style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <Text>Loading settings...</Text>
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
        <Title level={4} style={{ margin: 0 }}>
          Settings
        </Title>
      </Header>

      <Content style={{ padding: '24px', maxWidth: 800, margin: '0 auto' }}>
        <Card style={{ marginBottom: 24 }}>
          <Title level={4} style={{ marginTop: 0 }}>Profile</Title>
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            {/* Avatar Section - Placeholder for future */}
            <div style={{ textAlign: 'center' }}>
              <Avatar size={80} icon={<UserOutlined />} style={{ backgroundColor: '#1890ff' }} />
              <div style={{ marginTop: 8 }}>
                <Text type="secondary" style={{ fontSize: '12px' }}>
                  Avatar customization coming soon
                </Text>
              </div>
            </div>

            {/* Display Name Section */}
            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>
                Display Name
              </Text>
              {isEditingName ? (
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onPressEnter={handleSaveName}
                    placeholder="Enter display name"
                    autoFocus
                  />
                  <Button
                    icon={<CheckOutlined />}
                    onClick={handleSaveName}
                    type="primary"
                    disabled={!nameInput.trim()}
                  />
                  <Button
                    icon={<CloseOutlined />}
                    onClick={handleCancelEdit}
                  />
                </Space.Compact>
              ) : (
                <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: '16px' }}>{userInfo?.name}</Text>
                  <Button
                    icon={<EditOutlined />}
                    onClick={() => setIsEditingName(true)}
                    type="text"
                    size="small"
                  />
                </Space>
              )}
            </div>

            {/* User ID Section */}
            <div>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>
                User ID
              </Text>
              <Text type="secondary">{userInfo?.id}</Text>
            </div>
          </Space>
        </Card>

        <Card>
          <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Title level={4} style={{ margin: 0 }}>AI Models</Title>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setAddModalVisible(true)}
            >
              Add Model
            </Button>
          </div>

          <Table
            columns={modelColumns}
            dataSource={models}
            rowKey="id"
            loading={modelsLoading}
            pagination={false}
            locale={{
              emptyText: (
                <div style={{ padding: '32px 0' }}>
                  <Text type="secondary">
                    No AI models configured. Add a model to get started.
                  </Text>
                </div>
              )
            }}
          />

          <div style={{ marginTop: 24 }}>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>
              Quick Model
            </Text>
            <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
              Used for simple tasks like generating chat titles. Choose a fast, inexpensive model.
            </Text>
            <Select
              style={{ width: 300 }}
              value={quickModel}
              onChange={handleQuickModelChange}
              loading={quickModelLoading}
              placeholder="Select a model"
              options={[
                { value: null, label: 'None' },
                ...models.map(model => ({
                  value: model.id,
                  label: model.name,
                }))
              ]}
            />
          </div>
        </Card>

        <AddModelModal
          visible={addModalVisible}
          onCancel={() => setAddModalVisible(false)}
          onSuccess={() => {
            setAddModalVisible(false)
            fetchModels()
          }}
          authenticatedApi={authenticatedApi}
        />
      </Content>
    </Layout>
  )
}
