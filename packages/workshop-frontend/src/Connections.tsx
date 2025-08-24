import { useState, useEffect } from 'react'
import { Button, Table, Input, Space, Typography, Modal, message, Card, Empty } from 'antd'
import { PlusOutlined, EditOutlined, CheckOutlined, CloseOutlined, DeleteOutlined } from '@ant-design/icons'
import { RpcStub } from '@cloudflare/jsrpc'
import { Overseer, GatekeeperMetadata } from '@minions/workshop-shared/api'

const { Title, Text } = Typography

interface ConnectionsProps {
  overseer: RpcStub<Overseer>
  onConnectionsChange?: () => void
}

export default function Connections({ overseer, onConnectionsChange }: ConnectionsProps) {
  const [gatekeepers, setGatekeepers] = useState<GatekeeperMetadata[]>([])
  const [loading, setLoading] = useState(true)
  const [editingGatekeeper, setEditingGatekeeper] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [isNewConnectionModalVisible, setIsNewConnectionModalVisible] = useState(false)
  const [newConnectionUrl, setNewConnectionUrl] = useState('')
  const [creatingConnection, setCreatingConnection] = useState(false)

  const loadGatekeepers = async () => {
    try {
      const gatekeeperList = await overseer.listGatekeepers()
      setGatekeepers(gatekeeperList)
    } catch (err) {
      console.error('Failed to load gatekeepers:', err)
      message.error('Failed to load connections')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadGatekeepers()
  }, [overseer])

  const handleEditStart = (bindingName: string) => {
    setEditingGatekeeper(bindingName)
    setEditValue(bindingName)
  }

  const handleEditSave = async (bindingName: string) => {
    if (!editValue.trim()) {
      message.error('Binding name cannot be empty')
      return
    }

    try {
      const gatekeeper = await overseer.getGatekeeper(bindingName)
      if (gatekeeper) {
        await gatekeeper.setBindingName(editValue.trim())
        await loadGatekeepers()
        onConnectionsChange?.()
      }
    } catch (err) {
      console.error('Failed to rename gatekeeper:', err)
      message.error('Failed to update binding name')
    } finally {
      setEditingGatekeeper(null)
    }
  }

  const handleEditCancel = () => {
    setEditingGatekeeper(null)
    setEditValue('')
  }

  const handleDelete = async (bindingName: string, resourceTitle: string) => {
    Modal.confirm({
      title: 'Delete Connection',
      content: `Are you sure you want to delete the connection "${resourceTitle}" (${bindingName})? This action cannot be undone.`,
      okText: 'Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          const gatekeeper = await overseer.getGatekeeper(bindingName)
          if (gatekeeper) {
            await gatekeeper.remove()
            await loadGatekeepers()
            onConnectionsChange?.()
          }
        } catch (err) {
          console.error('Failed to delete gatekeeper:', err)
          message.error('Failed to delete connection')
        }
      }
    })
  }

  const handleNewConnection = async () => {
    if (!newConnectionUrl.trim()) {
      message.error('Please enter a URL')
      return
    }

    setCreatingConnection(true)
    try {
      const gatekeeper = await overseer.newGatekeeper(newConnectionUrl.trim())
      if (gatekeeper) {
        message.success('Connection created successfully')
        setIsNewConnectionModalVisible(false)
        setNewConnectionUrl('')
        await loadGatekeepers()
        onConnectionsChange?.()
      } else {
        message.error('Failed to create connection - unsupported URL or invalid resource')
      }
    } catch (err) {
      console.error('Failed to create gatekeeper:', err)
      message.error('Failed to create connection')
    } finally {
      setCreatingConnection(false)
    }
  }

  const columns = [
    {
      title: 'Binding Name',
      dataIndex: 'bindingName',
      key: 'bindingName',
      width: '33%',
      render: (bindingName: string) => {
        const isEditing = editingGatekeeper === bindingName
        return isEditing ? (
          <Space.Compact style={{ display: 'flex', alignItems: 'center' }}>
            <Input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onPressEnter={() => handleEditSave(bindingName)}
              placeholder="Enter binding name"
              autoFocus
              size="small"
              style={{ flex: 1 }}
            />
            <Button
              size="small"
              type="primary"
              icon={<CheckOutlined />}
              onClick={() => handleEditSave(bindingName)}
              disabled={!editValue.trim()}
            />
            <Button
              size="small"
              icon={<CloseOutlined />}
              onClick={handleEditCancel}
            />
          </Space.Compact>
        ) : (
          <Space>
            <Text code>{bindingName}</Text>
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              onClick={() => handleEditStart(bindingName)}
            />
            <Button
              size="small"
              type="text"
              icon={<DeleteOutlined />}
              danger
              onClick={(e) => {
                e.stopPropagation()
                const record = gatekeepers.find(g => g.bindingName === bindingName)
                if (record) {
                  handleDelete(bindingName, record.resourceTitle)
                }
              }}
            />
          </Space>
        )
      }
    },
    {
      title: 'Resource Title',
      dataIndex: 'resourceTitle',
      key: 'resourceTitle',
      render: (title: string) => <Text strong>{title}</Text>
    }
  ]

  return (
    <div style={{ padding: '24px', height: 'calc(100vh - 64px - 46px)', overflow: 'auto', backgroundColor: '#f5f5f5' }}>
      <div style={{ marginBottom: '24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Title level={4} style={{ margin: 0 }}>
          Connections
        </Title>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setIsNewConnectionModalVisible(true)}
        >
          New Connection
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={gatekeepers}
        rowKey="bindingName"
        loading={loading}
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span>
                  No connections yet. <br />
                  Click "New Connection" to connect to external resources.
                </span>
              }
            />
          )
        }}
      />

      <Modal
        title="Create New Connection"
        open={isNewConnectionModalVisible}
        onOk={handleNewConnection}
        onCancel={() => {
          setIsNewConnectionModalVisible(false)
          setNewConnectionUrl('')
        }}
        okText="Create Connection"
        cancelText="Cancel"
        confirmLoading={creatingConnection}
        okButtonProps={{ disabled: !newConnectionUrl.trim() }}
      >
        <div style={{ marginBottom: '16px' }}>
          <Text>
            Enter the URL of the resource you want to connect to. This will create a new connection 
            that your minion can use to interact with external services.
          </Text>
        </div>
        <Input
          placeholder="https://example.com/api"
          value={newConnectionUrl}
          onChange={(e) => setNewConnectionUrl(e.target.value)}
          onPressEnter={handleNewConnection}
          autoFocus
        />
      </Modal>
    </div>
  )
}