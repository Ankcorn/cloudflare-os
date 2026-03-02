import { useState, useEffect } from 'react'
import { Button, Table, Input, Space, Typography, Modal, message, Empty } from 'antd'
import { PlusOutlined, EditOutlined, CheckOutlined, CloseOutlined, DeleteOutlined, CaretRightOutlined } from '@ant-design/icons'
import { RpcStub } from 'capnweb'
import { Overseer, GatekeeperMetadata, ActionLogEntry, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import NewGatekeeperModal from './NewGatekeeperModal'


const { Title, Text, Link } = Typography

interface ConnectionsProps {
  overseer: RpcStub<Overseer>
  authenticatedApi: RpcStub<AuthenticatedApi>
  onConnectionsChange?: () => void
  isVisible?: boolean
  onHasGatekeepersChange?: (hasGatekeepers: boolean) => void
}

export default function Connections({ overseer, authenticatedApi: _authenticatedApi, onConnectionsChange, isVisible, onHasGatekeepersChange }: ConnectionsProps) {
  const [gatekeepers, setGatekeepers] = useState<GatekeeperMetadata[]>([])
  const [actions, setActions] = useState<ActionLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [actionsLoading, setActionsLoading] = useState(true)
  const [editingGatekeeper, setEditingGatekeeper] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [isNewConnectionModalVisible, setIsNewConnectionModalVisible] = useState(false)
  const [processingActions, setProcessingActions] = useState<Set<number>>(new Set())

  const loadGatekeepers = async () => {
    try {
      const gatekeeperList = await overseer.listGatekeepers()
      setGatekeepers(gatekeeperList)
      onHasGatekeepersChange?.(gatekeeperList.length > 0)
    } catch (err) {
      console.error('Failed to load gatekeepers:', err)
      message.error('Failed to load connections')
    } finally {
      setLoading(false)
    }
  }

  const loadActions = async () => {
    try {
      const actionsList = await overseer.listActions()
      setActions(actionsList)
    } catch (err) {
      console.error('Failed to load actions:', err)
      message.error('Failed to load actions')
    } finally {
      setActionsLoading(false)
    }
  }

  useEffect(() => {
    loadGatekeepers()
    loadActions()
  }, [overseer])

  useEffect(() => {
    if (isVisible) {
      loadActions()
    }
  }, [isVisible])

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
      using gatekeeper = await overseer.getGatekeeper(bindingName)
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
          using gatekeeper = await overseer.getGatekeeper(bindingName)
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

  const handleApproveAction = async (actionId: number) => {
    setProcessingActions(prev => new Set(prev).add(actionId))
    try {
      await overseer.approveAction(actionId)
      await loadActions()
    } catch (err) {
      console.error('Failed to approve action:', err)
      message.error('Failed to approve action')
    } finally {
      setProcessingActions(prev => {
        const newSet = new Set(prev)
        newSet.delete(actionId)
        return newSet
      })
    }
  }

  const handleRejectAction = async (actionId: number) => {
    setProcessingActions(prev => new Set(prev).add(actionId))
    try {
      await overseer.rejectAction(actionId)
      await loadActions()
    } catch (err) {
      console.error('Failed to reject action:', err)
      message.error('Failed to reject action')
    } finally {
      setProcessingActions(prev => {
        const newSet = new Set(prev)
        newSet.delete(actionId)
        return newSet
      })
    }
  }


  const formatDate = (date: Date) => {
    return new Date(date).toLocaleString()
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

  const actionsColumns = [
    {
      title: 'Resource',
      key: 'resource',
      width: '15%',
      render: (_: any, record: ActionLogEntry) => (
        <span>
          {record.bindingName && <><Text code>{record.bindingName}</Text>{' '}</>}
          {record.resourceUrl
            ? <Link href={record.resourceUrl} target="_blank">{record.resourceTitle}</Link>
            : <Text>{record.resourceTitle}</Text>}
        </span>
      )
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: '15%',
      render: (date: Date) => <Text>{formatDate(date)}</Text>
    },
    {
      title: 'Action',
      dataIndex: ['description', 'title'],
      key: 'title',
      width: '45%',
      render: (title: string) => <Text>{title}</Text>
    },
    {
      title: 'Status',
      key: 'status',
      width: '25%',
      render: (_: any, record: ActionLogEntry) => {
        const isProcessing = processingActions.has(record.id)

        if (record.state === 'pending') {
          return (
            <Space>
              <Button
                size="small"
                type="primary"
                onClick={() => handleApproveAction(record.id)}
                loading={isProcessing}
                disabled={isProcessing}
              >
                Approve
              </Button>
              <Button
                size="small"
                danger
                onClick={() => handleRejectAction(record.id)}
                loading={isProcessing}
                disabled={isProcessing}
              >
                Reject
              </Button>
            </Space>
          )
        } else if (record.state === 'approved') {
          return <Text type="secondary">Approved {record.appliedAt ? formatDate(record.appliedAt) : ''}</Text>
        } else if (record.state === 'rejected') {
          return <Text type="secondary">Rejected</Text>
        }
        return null
      }
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

      <div style={{ marginTop: '32px', marginBottom: '16px' }}>
        <Title level={5} style={{ margin: 0 }}>
          Action Log ({actions.length})
        </Title>
      </div>
      <Table
        columns={actionsColumns}
        dataSource={actions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())}
        rowKey="id"
        loading={actionsLoading}
        pagination={{ pageSize: 20 }}
        expandable={{
          expandedRowRender: (record: ActionLogEntry) => (
            <div style={{ padding: '16px', backgroundColor: '#fafafa', borderRadius: '4px' }}>
              <Typography.Paragraph>
                <strong>Description:</strong>
              </Typography.Paragraph>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {record.description.description}
              </Typography.Paragraph>
            </div>
          ),
          rowExpandable: () => true,
          expandIcon: ({ expanded, onExpand, record }) =>
            expanded ? (
              <CaretRightOutlined rotate={90} onClick={e => onExpand(record, e)} />
            ) : (
              <CaretRightOutlined onClick={e => onExpand(record, e)} />
            )
        }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No actions yet. Actions will appear here as the gadget interacts with external resources."
            />
          )
        }}
      />

      <NewGatekeeperModal
        open={isNewConnectionModalVisible}
        onClose={() => setIsNewConnectionModalVisible(false)}
        getOverseer={() => overseer}
        existingBindings={gatekeepers.map(g => g.bindingName)}
        onCreated={async (gk) => {
          try {
            await gk.setSuggestedBindingName()
            message.success('Connection created successfully')
            await loadGatekeepers()
            onConnectionsChange?.()
          } finally {
            gk[Symbol.dispose]()
          }
        }}
      />
    </div>
  )
}
