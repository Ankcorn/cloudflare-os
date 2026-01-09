import { useState, useEffect, useRef } from 'react'
import { Button, Table, Input, Space, Typography, Modal, message, Empty, Tag, Tabs, Select, Spin } from 'antd'
import { PlusOutlined, EditOutlined, CheckOutlined, CloseOutlined, DeleteOutlined, CaretRightOutlined, ArrowLeftOutlined } from '@ant-design/icons'
import { RpcStub, RpcTarget } from 'capnweb'
import { Overseer, GatekeeperMetadata, ActionLogEntry, AiChatAuthorInfo, AuthenticatedApi, ConnenctedAccountsSubscriber } from '@minions/workshop-shared/api'
import { AccountDescription, VendorDescription } from '@minions/workshop-shared/gatekeeper'
import AccountCard from './AccountCard'
import VendorCard from './VendorCard'

const { Title, Text } = Typography

interface ConnectionsProps {
  overseer: RpcStub<Overseer>
  authenticatedApi: RpcStub<AuthenticatedApi>
  onConnectionsChange?: () => void
  isVisible?: boolean
}

interface VendorOption {
  id: string
  description: VendorDescription
}

export default function Connections({ overseer, authenticatedApi, onConnectionsChange, isVisible }: ConnectionsProps) {
  const [gatekeepers, setGatekeepers] = useState<GatekeeperMetadata[]>([])
  const [actions, setActions] = useState<ActionLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [actionsLoading, setActionsLoading] = useState(true)
  const [editingGatekeeper, setEditingGatekeeper] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [isNewConnectionModalVisible, setIsNewConnectionModalVisible] = useState(false)
  const [newConnectionUrl, setNewConnectionUrl] = useState('')
  const [creatingConnection, setCreatingConnection] = useState(false)
  const [processingActions, setProcessingActions] = useState<Set<number>>(new Set())
  const [connectionTabKey, setConnectionTabKey] = useState<'resource' | 'ai-model'>('resource')
  const [availableModels, setAvailableModels] = useState<AiChatAuthorInfo[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>()

  // Two-step flow state for resource connections
  const [connectionStep, setConnectionStep] = useState<'url' | 'account'>('url')
  const [filteredAccounts, setFilteredAccounts] = useState<Map<number, { description: AccountDescription, vendor: VendorDescription }>>(new Map())
  const [filteredVendors, setFilteredVendors] = useState<VendorOption[]>([])
  const [accountsReady, setAccountsReady] = useState(false)
  const [vendorsLoading, setVendorsLoading] = useState(false)
  const [connectingVendor, setConnectingVendor] = useState<string | null>(null)

  // Ref to track the current subscription
  const subscriptionRef = useRef<{ stub: { [Symbol.dispose](): void } } | null>(null)
  // Track whether we've ever received ready() for the current URL context - only show spinner until first ready
  const everReadyForUrlRef = useRef(false)
  // Track whether we've ever loaded vendors for the current URL context
  const everLoadedVendorsForUrlRef = useRef(false)
  // Track the URL for which the "ever ready/loaded" refs apply
  const readyUrlRef = useRef<string | null>(null)
  // Track account IDs seen in current subscription batch (for reconnection handling)
  const seenAccountIdsRef = useRef(new Set<number>())

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

  const loadModels = async () => {
    try {
      const models = await overseer.listModels()
      setAvailableModels(models)
      // Set the first model as default if available
      if (models.length > 0 && !selectedModelId) {
        setSelectedModelId(models[0].id)
      }
    } catch (err) {
      console.error('Failed to load models:', err)
      message.error('Failed to load AI models')
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

  // Subscribe to filtered accounts when in account selection step
  useEffect(() => {
    if (connectionStep !== 'account' || !newConnectionUrl.trim()) {
      return
    }

    const currentUrl = newConnectionUrl.trim()

    // Check if this is a new URL context (vs reconnection for same URL)
    if (readyUrlRef.current !== currentUrl) {
      // New URL context - reset tracking state
      everReadyForUrlRef.current = false
      everLoadedVendorsForUrlRef.current = false
      readyUrlRef.current = currentUrl
      seenAccountIdsRef.current = new Set()
    }

    // Create subscriber for filtered accounts
    class FilteredAccountsSubscriber extends RpcTarget implements ConnenctedAccountsSubscriber {
      add(id: number, description: AccountDescription, vendor: VendorDescription) {
        seenAccountIdsRef.current.add(id)
        setFilteredAccounts(prev => {
          const next = new Map(prev)
          next.set(id, { description, vendor })
          return next
        })
      }

      remove(id: number) {
        seenAccountIdsRef.current.delete(id)
        setFilteredAccounts(prev => {
          const next = new Map(prev)
          next.delete(id)
          return next
        })
      }

      ready() {
        // Capture seen set before clearing (must happen before setState callback runs)
        const seen = seenAccountIdsRef.current
        // Clear seen set for next subscription batch
        seenAccountIdsRef.current = new Set()
        // Mark as ready (only matters for first time for this URL)
        everReadyForUrlRef.current = true

        // On ready, remove any accounts that weren't seen in this subscription batch
        // (handles reconnection where some accounts may no longer be valid)
        setFilteredAccounts(prev => {
          let changed = false
          const next = new Map(prev)
          for (const id of next.keys()) {
            if (!seen.has(id)) {
              next.delete(id)
              changed = true
            }
          }
          return changed ? next : prev
        })
        setAccountsReady(true)
      }
    }

    const subscriber = new FilteredAccountsSubscriber()
    const filter = { resourceUrl: currentUrl }

    const subscribe = async () => {
      try {
        const stub = await authenticatedApi.subscribeConnectedAccounts(subscriber, filter)
        subscriptionRef.current = { stub }
      } catch (error) {
        console.error('Failed to subscribe to connected accounts:', error)
        // Mark as ready even on error so UI isn't stuck loading
        everReadyForUrlRef.current = true
        setAccountsReady(true)
      }
    }

    subscribe()

    return () => {
      if (subscriptionRef.current) {
        subscriptionRef.current.stub[Symbol.dispose]()
        subscriptionRef.current = null
      }
    }
  }, [connectionStep, newConnectionUrl, authenticatedApi])

  // Load filtered vendors when in account selection step
  useEffect(() => {
    if (connectionStep !== 'account' || !newConnectionUrl.trim()) {
      return
    }

    const loadFilteredVendors = async () => {
      // Only show loading spinner on first load for this URL, not on reconnection
      if (!everLoadedVendorsForUrlRef.current) {
        setVendorsLoading(true)
      }
      try {
        const filter = { resourceUrl: newConnectionUrl.trim() }
        const vendorList = await authenticatedApi.listGatekeeperVendors(filter)
        setFilteredVendors(vendorList.map(v => ({ id: v.id, description: v.description })))
        everLoadedVendorsForUrlRef.current = true
      } catch (error) {
        console.error('Failed to load vendors:', error)
        message.error('Failed to load available services')
      } finally {
        setVendorsLoading(false)
      }
    }

    loadFilteredVendors()
  }, [connectionStep, newConnectionUrl, authenticatedApi])

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

  const handleNextStep = () => {
    if (!newConnectionUrl.trim()) {
      message.error('Please enter a URL')
      return
    }
    const currentUrl = newConnectionUrl.trim()
    // Reset account selection state
    setFilteredAccounts(new Map())
    setFilteredVendors([])
    setAccountsReady(false)
    // Reset refs for new URL context (must be done synchronously before render)
    if (readyUrlRef.current !== currentUrl) {
      everReadyForUrlRef.current = false
      everLoadedVendorsForUrlRef.current = false
      readyUrlRef.current = currentUrl
      seenAccountIdsRef.current = new Set()
    }
    setConnectionStep('account')
  }

  const handleBackToUrl = () => {
    // Clean up subscription
    if (subscriptionRef.current) {
      subscriptionRef.current.stub[Symbol.dispose]()
      subscriptionRef.current = null
    }
    setConnectionStep('url')
    setFilteredAccounts(new Map())
    setFilteredVendors([])
    setAccountsReady(false)
    setConnectingVendor(null)
  }

  const handleSelectAccount = async (accountId: number) => {
    setCreatingConnection(true)
    try {
      const gatekeeper = await overseer.newGatekeeper(accountId, newConnectionUrl.trim())
      if (gatekeeper) {
        message.success('Connection created successfully')
        handleModalClose()
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

  const handleConnectNewAccount = async (vendorId: string) => {
    setConnectingVendor(vendorId)
    try {
      const result = await authenticatedApi.connectAccount(vendorId)
      window.open(result.url, '_blank')
      // Don't close the modal - the new account will appear via subscription
    } catch (error) {
      console.error('Failed to initiate connection:', error)
      message.error('Failed to start connection flow')
    } finally {
      setConnectingVendor(null)
    }
  }

  const handleNewAiModelConnection = async () => {
    if (!selectedModelId) {
      message.error('Please select an AI model')
      return
    }

    setCreatingConnection(true)
    try {
      const gatekeeper = await overseer.newAiModelGatekeeper(selectedModelId)
      if (gatekeeper) {
        message.success('AI model connection created successfully')
        handleModalClose()
        await loadGatekeepers()
        onConnectionsChange?.()
      } else {
        message.error('Failed to create AI model connection')
      }
    } catch (err) {
      console.error('Failed to create AI model gatekeeper:', err)
      message.error('Failed to create AI model connection')
    } finally {
      setCreatingConnection(false)
    }
  }

  const handleModalOpen = () => {
    setIsNewConnectionModalVisible(true)
    setConnectionTabKey('resource')
    setConnectionStep('url')
    setNewConnectionUrl('')
    setFilteredAccounts(new Map())
    setFilteredVendors([])
    setAccountsReady(false)
    setConnectingVendor(null)
    loadModels()
  }

  const handleModalClose = () => {
    // Clean up subscription
    if (subscriptionRef.current) {
      subscriptionRef.current.stub[Symbol.dispose]()
      subscriptionRef.current = null
    }
    setIsNewConnectionModalVisible(false)
    setNewConnectionUrl('')
    setConnectionTabKey('resource')
    setConnectionStep('url')
    setFilteredAccounts(new Map())
    setFilteredVendors([])
    setAccountsReady(false)
    setConnectingVendor(null)
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

  const getStatusTag = (action: ActionLogEntry) => {
    switch (action.state) {
      case 'pending':
        return <Tag color="orange">Pending</Tag>
      case 'approved':
        return <Tag color="green">Approved</Tag>
      case 'rejected':
        return <Tag color="red">Rejected</Tag>
      default:
        return <Tag>{action.state}</Tag>
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
      title: 'Binding',
      dataIndex: 'bindingName',
      key: 'bindingName',
      width: '15%',
      render: (bindingName: string) => <Text code>{bindingName}</Text>
    },
    {
      title: 'Created',
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: '15%',
      render: (date: Date) => <Text>{formatDate(date)}</Text>
    },
    {
      title: 'Title',
      dataIndex: ['description', 'title'],
      key: 'title',
      width: '45%',
      render: (title: string) => <Text>{title}</Text>
    },
    {
      title: 'Actions',
      key: 'actions',
      width: '25%',
      render: (_, record: ActionLogEntry) => {
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

  // Convert filtered accounts to array for rendering
  const filteredAccountsArray = Array.from(filteredAccounts.entries()).map(([id, data]) => ({
    id,
    ...data
  }))

  // Render the resource tab content based on the current step
  const renderResourceTabContent = () => {
    if (connectionStep === 'url') {
      return (
        <>
          <div style={{ marginBottom: '16px' }}>
            <Text>
              Enter the URL of the resource you want to connect to. This will create a new connection
              that your minion can use to interact with external services.
            </Text>
          </div>
          <Input
            placeholder="https://example.com/resource"
            value={newConnectionUrl}
            onChange={(e) => setNewConnectionUrl(e.target.value)}
            onPressEnter={handleNextStep}
            autoFocus
          />
        </>
      )
    }

    // Account selection step
    // Only show spinner until first load completes - on reconnection, keep showing existing list
    const isLoading = !everReadyForUrlRef.current || !everLoadedVendorsForUrlRef.current
    const hasAccounts = filteredAccountsArray.length > 0
    const hasVendors = filteredVendors.length > 0

    return (
      <div style={{ minHeight: 200 }}>
        <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            onClick={handleBackToUrl}
            size="small"
          />
          <Text type="secondary">
            Select an account to access: <Text code>{newConnectionUrl}</Text>
          </Text>
        </div>

        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <Spin />
          </div>
        ) : !hasAccounts && !hasVendors ? (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <Text type="secondary">
              No accounts or services are available that can access this URL.
            </Text>
          </div>
        ) : (
          <>
            {/* Existing connected accounts section */}
            {hasAccounts && (
              <div style={{ marginBottom: 24 }}>
                <Text strong style={{ display: 'block', marginBottom: 12 }}>
                  Your Accounts
                </Text>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {filteredAccountsArray.map(account => (
                    <AccountCard
                      key={account.id}
                      account={account.description}
                      vendor={account.vendor}
                      onClick={() => handleSelectAccount(account.id)}
                      disabled={creatingConnection}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Connect new account section */}
            {hasVendors && (
              <div>
                <Text strong style={{ display: 'block', marginBottom: 12 }}>
                  Connect New Account
                </Text>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {filteredVendors.map(vendor => (
                    <VendorCard
                      key={vendor.id}
                      vendor={vendor.description}
                      onClick={() => handleConnectNewAccount(vendor.id)}
                      loading={connectingVendor === vendor.id}
                      disabled={connectingVendor !== null && connectingVendor !== vendor.id}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  return (
    <div style={{ padding: '24px', height: 'calc(100vh - 64px - 46px)', overflow: 'auto', backgroundColor: '#f5f5f5' }}>
      <div style={{ marginBottom: '24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Title level={4} style={{ margin: 0 }}>
          Connections
        </Title>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={handleModalOpen}
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
              description="No actions yet. Actions will appear here as the minion interacts with external resources."
            />
          )
        }}
      />

      <Modal
        title="Create New Connection"
        open={isNewConnectionModalVisible}
        onOk={connectionTabKey === 'ai-model' ? handleNewAiModelConnection : undefined}
        onCancel={handleModalClose}
        okText={connectionTabKey === 'resource' && connectionStep === 'url' ? 'Next' : 'Create Connection'}
        cancelText="Cancel"
        confirmLoading={creatingConnection}
        okButtonProps={{
          disabled: connectionTabKey === 'resource'
            ? (connectionStep === 'url' ? !newConnectionUrl.trim() : false)
            : !selectedModelId,
          // Hide the OK button in account selection step (users click on cards instead)
          style: connectionTabKey === 'resource' && connectionStep === 'account' ? { display: 'none' } : undefined
        }}
        footer={connectionTabKey === 'resource' && connectionStep === 'account' ? null : undefined}
        onOk={() => {
          if (connectionTabKey === 'resource' && connectionStep === 'url') {
            handleNextStep()
          } else if (connectionTabKey === 'ai-model') {
            handleNewAiModelConnection()
          }
        }}
      >
        <Tabs
          activeKey={connectionTabKey}
          onChange={(key) => {
            setConnectionTabKey(key as 'resource' | 'ai-model')
            // Reset resource step when switching tabs
            if (key === 'resource') {
              setConnectionStep('url')
            }
          }}
          items={[
            {
              key: 'resource',
              label: 'Resource',
              children: renderResourceTabContent()
            },
            {
              key: 'ai-model',
              label: 'AI Model',
              children: (
                <>
                  <div style={{ marginBottom: '16px' }}>
                    <Text>
                      Select an AI model to create a connection. This allows your minion to interact
                      with AI capabilities as a binding.
                    </Text>
                  </div>
                  <Select
                    style={{ width: '100%' }}
                    placeholder="Select an AI model"
                    value={selectedModelId}
                    onChange={setSelectedModelId}
                    options={availableModels.map(model => ({
                      label: model.name,
                      value: model.id
                    }))}
                  />
                </>
              )
            }
          ]}
        />
      </Modal>
    </div>
  )
}
