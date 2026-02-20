import { useState, useEffect, useRef } from 'react'
import { Button, Table, Input, Space, Typography, Modal, message, Empty, Tabs, Select, Spin, Checkbox } from 'antd'
import { PlusOutlined, EditOutlined, CheckOutlined, CloseOutlined, DeleteOutlined, CaretRightOutlined, ArrowLeftOutlined, SearchOutlined, RightOutlined } from '@ant-design/icons'
import { RpcStub, RpcTarget } from 'capnweb'
import { Overseer, GatekeeperMetadata, ActionLogEntry, AiChatAuthorInfo, AuthenticatedApi, ConnenctedAccountsSubscriber, AgentSpawnerConfig } from '@gadgets/workshop-shared/api'
import { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'


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
  supportedResources: SupportedResource[]
}

// Extract a base URL from a resource pattern, e.g. "https://jira.cfdata.org/*" → "https://jira.cfdata.org/"
// Returns null for wildcard hostnames (e.g. "https://*.example.com/*") since we can't pre-fill.
function extractBaseUrl(pattern: string): string | null {
  const match = pattern.match(/^(https?:\/\/[^/*:]+(?:\/[^*]*)?)/)
  if (!match) return null
  return match[1].endsWith('/') ? match[1] : match[1] + '/'
}

// Extract the hostname from a pattern, including wildcard subdomains.
// e.g. "https://jira.cfdata.org/*" → "jira.cfdata.org"
// e.g. "https://*.prometheus-access.cfdata.org/*" → "*.prometheus-access.cfdata.org"
function extractHostname(pattern: string): string | null {
  const match = pattern.match(/^https?:\/\/([^/:]+)/)
  if (!match) return null
  const hostname = match[1].replace(/\*+$/, '') // strip trailing wildcard (e.g. https://*)
  return hostname || null
}

// URL prefix match: strip scheme and trailing wildcards, then check if one is a prefix
// of the other. Handles partial typing ("jira.cfdata.or") and full URLs with paths.
// Also handles wildcard subdomain patterns like "*.prometheus-access.cfdata.org".
function matchesResourceUrl(search: string, pattern: string): boolean {
  const stripScheme = (s: string) => s.replace(/^https?:\/\//, '').toLowerCase()
  const s = stripScheme(search).replace(/\*+$/, '')
  const p = stripScheme(pattern).replace(/\*+$/, '')
  if (!s) return false

  // Wildcard subdomain: *.foo.com matches anything.foo.com
  if (p.startsWith('*.')) {
    const suffixHost = p.slice(1).split('/')[0] // ".foo.com"
    const searchHost = s.split('/')[0]
    if (searchHost.endsWith(suffixHost) || suffixHost.startsWith('.' + searchHost)) return true
  }

  return p.startsWith(s) || s.startsWith(p)
}

// Check if search text matches a resource. Tries URL prefix matching (scheme-optional),
// then falls back to multi-word token matching against title/description/pattern.
function matchesResource(search: string, resource: SupportedResource): boolean {
  if (matchesResourceUrl(search.trim(), resource.urlPattern)) return true
  const corpus = `${resource.title} ${resource.description} ${resource.urlPattern}`.toLowerCase()
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean)
  return tokens.every(t => corpus.includes(t))
}

export default function Connections({ overseer, authenticatedApi, onConnectionsChange, isVisible }: ConnectionsProps) {
  const [gatekeepers, setGatekeepers] = useState<GatekeeperMetadata[]>([])
  const [actions, setActions] = useState<ActionLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [actionsLoading, setActionsLoading] = useState(true)
  const [editingGatekeeper, setEditingGatekeeper] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [isNewConnectionModalVisible, setIsNewConnectionModalVisible] = useState(false)
  const [creatingConnection, setCreatingConnection] = useState(false)
  const [processingActions, setProcessingActions] = useState<Set<number>>(new Set())
  const [connectionTabKey, setConnectionTabKey] = useState<'resource' | 'ai-model' | 'agent-spawner'>('resource')
  const [availableModels, setAvailableModels] = useState<AiChatAuthorInfo[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>()

  // Agent spawner tab state
  const [spawnerDisplayName, setSpawnerDisplayName] = useState('')
  const [spawnerModelId, setSpawnerModelId] = useState<string | null>(null)
  const [spawnerPropsTypeName, setSpawnerPropsTypeName] = useState('')
  const [spawnerPropsTsTypes, setSpawnerPropsTsTypes] = useState('')
  const [spawnerLimitEnv, setSpawnerLimitEnv] = useState(false)
  const [spawnerEnv, setSpawnerEnv] = useState<string[]>([])

  // Unified resource connection state
  const [searchText, setSearchText] = useState('')
  const [allAccounts, setAllAccounts] = useState<Map<number, { description: AccountDescription, vendor: VendorDescription, supportedResources: SupportedResource[] }>>(new Map())
  const [allVendors, setAllVendors] = useState<VendorOption[]>([])
  const [_accountsReady, setAccountsReady] = useState(false)
  const [vendorsLoading, setVendorsLoading] = useState(false)
  const [connectingVendor, setConnectingVendor] = useState<string | null>(null)
  const [selectedAccountForUrl, setSelectedAccountForUrl] = useState<number | null>(null)
  const [selectedVendorForUrl, setSelectedVendorForUrl] = useState<string | null>(null)
  const [resourceUrlInput, setResourceUrlInput] = useState('')

  // Ref to track the current subscription
  const subscriptionRef = useRef<{ stub: { [Symbol.dispose](): void } } | null>(null)
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
      // Default spawner model: use last-selected model from chat (localStorage), else first model
      if (models.length > 0) {
        const lastSelectedModel = localStorage.getItem('lastSelectedModel')
        if (lastSelectedModel && models.some(m => m.id === lastSelectedModel)) {
          setSpawnerModelId(lastSelectedModel)
        } else {
          setSpawnerModelId(models[0].id)
        }
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

  // Subscribe to ALL connected accounts when modal opens (no filter).
  // New accounts from OAuth completion appear live via this subscription.
  useEffect(() => {
    if (!isNewConnectionModalVisible) return

    seenAccountIdsRef.current = new Set()

    class AccountsSubscriber extends RpcTarget implements ConnenctedAccountsSubscriber {
      add(id: number, description: AccountDescription, vendor: VendorDescription, supportedResources: SupportedResource[] = []) {
        seenAccountIdsRef.current.add(id)
        setAllAccounts(prev => {
          const next = new Map(prev)
          next.set(id, { description, vendor, supportedResources })
          return next
        })
      }

      remove(id: number) {
        seenAccountIdsRef.current.delete(id)
        setAllAccounts(prev => {
          const next = new Map(prev)
          next.delete(id)
          return next
        })
      }

      ready() {
        const seen = seenAccountIdsRef.current
        seenAccountIdsRef.current = new Set()
        setAllAccounts(prev => {
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

    const subscriber = new AccountsSubscriber()
    const subscribe = async () => {
      try {
        const stub = await authenticatedApi.subscribeConnectedAccounts(subscriber)
        subscriptionRef.current = { stub }
      } catch (error) {
        console.error('Failed to subscribe to connected accounts:', error)
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
  }, [isNewConnectionModalVisible, authenticatedApi])

  // Load ALL vendors (with supportedResources) when modal opens.
  useEffect(() => {
    if (!isNewConnectionModalVisible) return

    const loadVendors = async () => {
      setVendorsLoading(true)
      try {
        const vendorList = await authenticatedApi.listGatekeeperVendors()
        setAllVendors(vendorList.map(v => ({ id: v.id, description: v.description, supportedResources: v.supportedResources })))
      } catch (error) {
        console.error('Failed to load vendors:', error)
        message.error('Failed to load available services')
      } finally {
        setVendorsLoading(false)
      }
    }
    loadVendors()
  }, [isNewConnectionModalVisible, authenticatedApi])

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

  const handleBackFromUrlEntry = () => {
    setSelectedAccountForUrl(null)
    setSelectedVendorForUrl(null)
    setResourceUrlInput('')
  }

  const handleCreateConnection = async (accountId: number, url: string) => {
    setCreatingConnection(true)
    try {
      const gatekeeper = await overseer.newGatekeeper(accountId, url)
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

  const handleConnectNew = async (vendorId: string) => {
    setConnectingVendor(vendorId)
    try {
      const result = await authenticatedApi.connectAccount(vendorId)
      window.open(result.url, '_blank')
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

  const handleNewAgentSpawnerConnection = async () => {
    if (!spawnerDisplayName.trim()) {
      message.error('Please enter a display name')
      return
    }

    const config: AgentSpawnerConfig = {
      displayName: spawnerDisplayName.trim(),
      modelId: spawnerModelId,
    }

    const trimmedTypeName = spawnerPropsTypeName.trim()
    if (trimmedTypeName) {
      config.propsTypeName = trimmedTypeName
    }

    const trimmedTsTypes = spawnerPropsTsTypes.trim()
    if (trimmedTsTypes) {
      config.propsTsTypes = trimmedTsTypes
    }

    if (spawnerLimitEnv) {
      config.env = spawnerEnv
    }

    setCreatingConnection(true)
    try {
      const gatekeeper = await overseer.newAgentSpawnerGatekeeper(config)
      if (gatekeeper) {
        message.success('Agent spawner connection created successfully')
        handleModalClose()
        await loadGatekeepers()
        onConnectionsChange?.()
      } else {
        message.error('Failed to create agent spawner connection')
      }
    } catch (err) {
      console.error('Failed to create agent spawner gatekeeper:', err)
      message.error('Failed to create agent spawner connection')
    } finally {
      setCreatingConnection(false)
    }
  }

  const resetSpawnerState = () => {
    setSpawnerDisplayName('')
    setSpawnerModelId(null)
    setSpawnerPropsTypeName('')
    setSpawnerPropsTsTypes('')
    setSpawnerLimitEnv(false)
    setSpawnerEnv([])
  }

  const handleModalOpen = () => {
    setIsNewConnectionModalVisible(true)
    setConnectionTabKey('resource')
    setSearchText('')
    setAllAccounts(new Map())
    setAllVendors([])
    setAccountsReady(false)
    setSelectedAccountForUrl(null)
    setSelectedVendorForUrl(null)
    setResourceUrlInput('')
    setConnectingVendor(null)
    resetSpawnerState()
    loadModels()
  }

  const handleModalClose = () => {
    if (subscriptionRef.current) {
      subscriptionRef.current.stub[Symbol.dispose]()
      subscriptionRef.current = null
    }
    setIsNewConnectionModalVisible(false)
    setSearchText('')
    setConnectionTabKey('resource')
    setAllAccounts(new Map())
    setAllVendors([])
    setAccountsReady(false)
    setSelectedAccountForUrl(null)
    setSelectedVendorForUrl(null)
    setResourceUrlInput('')
    setConnectingVendor(null)
    resetSpawnerState()
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

  // Render the resource tab content
  const renderResourceTabContent = () => {
    // Sub-step: user picked a (resource, account) pair and is entering the resource URL.
    if (selectedVendorForUrl !== null && selectedAccountForUrl !== null) {
      const vendor = allVendors.find(v => v.id === selectedVendorForUrl)
      const vendorName = vendor?.description.displayName || ''
      const account = allAccounts.get(selectedAccountForUrl)

      return (
        <div style={{ minHeight: 200 }}>
          <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={handleBackFromUrlEntry} size="small" />
            <Text type="secondary">
              {vendorName} · <Text strong>{account?.description.displayName || account?.description.uniqueName}</Text>
            </Text>
          </div>
          <Input
            placeholder="https://example.com/resource"
            value={resourceUrlInput}
            onChange={(e) => setResourceUrlInput(e.target.value)}
            autoFocus
            style={{ marginBottom: 16 }}
          />
          <Button
            type="primary"
            block
            disabled={!resourceUrlInput.trim()}
            loading={creatingConnection}
            onClick={() => handleCreateConnection(selectedAccountForUrl!, resourceUrlInput.trim())}
          >
            Create Connection
          </Button>
        </div>
      )
    }

    const lowerSearch = searchText.toLowerCase().trim()

    const allResourceItems = allVendors.flatMap(v =>
      v.supportedResources.map(r => ({ resource: r, vendor: v }))
    )

    // Empty search matches everything; otherwise filter by resource.
    let matchedResources: { resource: SupportedResource, vendor: VendorOption, accountsOnly?: boolean }[] =
      lowerSearch
        ? allResourceItems.filter(({ resource }) => matchesResource(searchText, resource))
        : [...allResourceItems]

    // HTTP wildcard (`https://*`) shouldn't match when specific resources also match.
    // But connected HTTP accounts whose details match the search should still show.
    const httpItem = matchedResources.find(({ resource }) => resource.urlPattern === 'https://*')
    const hasSpecificMatches = matchedResources.some(({ resource }) => resource.urlPattern !== 'https://*')

    if (lowerSearch && httpItem && hasSpecificMatches) {
      matchedResources = matchedResources.filter(({ resource }) => resource.urlPattern !== 'https://*')

      // Check if any connected HTTP accounts match the search.
      const httpVendorName = httpItem.vendor.description.displayName
      const httpAccounts = [...allAccounts.entries()]
        .filter(([_, { vendor: v }]) => v.displayName === httpVendorName)

      const hasMatchingAccounts = lowerSearch
        ? httpAccounts.some(([_, { description }]) => {
            const corpus = [description.displayName, description.uniqueName, ...description.scope]
              .filter(Boolean).join(' ').toLowerCase()
            return lowerSearch.split(/\s+/).every(t => corpus.includes(t))
          })
        : httpAccounts.length > 0

      if (hasMatchingAccounts) {
        matchedResources.push({ ...httpItem, accountsOnly: true })
      }
    }

    return (
      <div>
        <Input
          placeholder="Search resources or paste a URL..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          autoFocus
          allowClear
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          style={{ borderRadius: 8 }}
        />

        <div style={{
          marginTop: 8,
          border: '1px solid #e8e8e8',
          borderRadius: 8,
          overflow: 'hidden',
          maxHeight: 400,
          overflowY: 'auto',
        }}>
          {vendorsLoading ? (
            <div style={{ textAlign: 'center', padding: '16px 0' }}>
              <Spin size="small" />
            </div>
          ) : matchedResources.length === 0 ? (
            <div style={{ padding: '12px 16px' }}>
              <Text type="secondary">No matching resources.</Text>
            </div>
          ) : (
            matchedResources.map(({ resource, vendor, accountsOnly }, i) => {
              let vendorAccounts = [...allAccounts.entries()]
                .filter(([_, { vendor: v }]) => v.displayName === vendor.description.displayName)
                .map(([id, data]) => ({ id, ...data }))

              // In accounts-only mode (HTTP alongside specific matches), only show
              // accounts whose details match the search.
              if (accountsOnly && lowerSearch) {
                vendorAccounts = vendorAccounts.filter(account => {
                  const corpus = [account.description.displayName, account.description.uniqueName, ...account.description.scope]
                    .filter(Boolean).join(' ').toLowerCase()
                  return lowerSearch.split(/\s+/).every(t => corpus.includes(t))
                })
              }

              if (accountsOnly && vendorAccounts.length === 0) return null

              const hostname = extractHostname(resource.urlPattern)

              return (
                <div key={`${vendor.id}-${resource.urlPattern}`} style={{ borderTop: i > 0 ? '1px solid #e8e8e8' : undefined }}>
                  {/* Resource header */}
                  <div style={{
                    padding: '8px 16px',
                    backgroundColor: '#fafafa',
                  }}>
                    <span style={{ fontWeight: 500, fontSize: 13 }}>{resource.title}</span>
                    <span style={{ color: '#8c8c8c', fontSize: 12, marginLeft: 6 }}>{resource.description}</span>
                  </div>

                  {/* Existing account rows — click to go to URL entry */}
                  {vendorAccounts.map(account => (
                    <div
                      key={account.id}
                      onClick={() => {
                        setSelectedVendorForUrl(vendor.id)
                        setSelectedAccountForUrl(account.id)
                        const accountBaseUrl = account.supportedResources
                          .map(r => extractBaseUrl(r.urlPattern)).find(Boolean)
                        setResourceUrlInput(accountBaseUrl || extractBaseUrl(resource.urlPattern) || 'https://')
                      }}
                      style={{
                        padding: '6px 16px 6px 32px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        borderTop: '1px solid #f5f5f5',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#f0f0f0')}
                      onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: 13 }}>
                          {account.description.uniqueName || account.description.displayName}
                        </Text>
                        {hostname && hostname !== '*' && (
                          <Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
                            {hostname}
                          </Text>
                        )}
                      </div>
                      <RightOutlined style={{ color: '#bfbfbf', fontSize: 10, flexShrink: 0 }} />
                    </div>
                  ))}

                  {/* Connect new account */}
                  {!accountsOnly && (
                    <div
                      onClick={() => !connectingVendor && handleConnectNew(vendor.id)}
                      style={{
                        padding: '6px 16px 6px 32px',
                        cursor: connectingVendor === vendor.id ? 'wait' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        borderTop: '1px solid #f5f5f5',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.backgroundColor = '#fafafa')}
                      onMouseLeave={e => (e.currentTarget.style.backgroundColor = '')}
                    >
                      {connectingVendor === vendor.id ? (
                        <Spin size="small" style={{ marginRight: 8 }} />
                      ) : (
                        <PlusOutlined style={{ marginRight: 8, color: '#8c8c8c', fontSize: 11 }} />
                      )}
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {connectingVendor === vendor.id ? 'Opening...' : 'Connect new account'}
                      </Text>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
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
              description="No actions yet. Actions will appear here as the gadget interacts with external resources."
            />
          )
        }}
      />

      <Modal
        title="Create New Connection"
        open={isNewConnectionModalVisible}
        onCancel={handleModalClose}
        okText="Create Connection"
        cancelText="Cancel"
        confirmLoading={creatingConnection}
        okButtonProps={{
          disabled: connectionTabKey === 'ai-model'
            ? !selectedModelId
            : !spawnerDisplayName.trim(),
        }}
        footer={connectionTabKey === 'resource' ? null : undefined}
        onOk={() => {
          if (connectionTabKey === 'ai-model') {
            handleNewAiModelConnection()
          } else if (connectionTabKey === 'agent-spawner') {
            handleNewAgentSpawnerConnection()
          }
        }}
      >
        <Tabs
          activeKey={connectionTabKey}
          onChange={(key) => {
            setConnectionTabKey(key as 'resource' | 'ai-model' | 'agent-spawner')
            if (key === 'resource') {
              setSelectedAccountForUrl(null)
              setSelectedVendorForUrl(null)
              setResourceUrlInput('')
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
                      Select an AI model to create a connection. This allows your gadget to interact
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
            },
            {
              key: 'agent-spawner',
              label: 'Agent Spawner',
              children: (
                <>
                  <div style={{ marginBottom: '16px' }}>
                    <Text>
                      Create an agent spawner binding. This allows your gadget to programmatically
                      start new AI agent conversations to perform tasks on given resources.
                    </Text>
                  </div>

                  <div style={{ marginBottom: '12px' }}>
                    <Text strong style={{ display: 'block', marginBottom: 4 }}>Display Name</Text>
                    <Input
                      placeholder="e.g. Email Responder"
                      value={spawnerDisplayName}
                      onChange={(e) => setSpawnerDisplayName(e.target.value)}
                    />
                  </div>

                  <div style={{ marginBottom: '12px' }}>
                    <Text strong style={{ display: 'block', marginBottom: 4 }}>Model</Text>
                    <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                      The AI model spawned agents will use. Choose "None" to create
                      conversations without an agent (requires manual attention).
                    </Text>
                    <Select
                      style={{ width: '100%' }}
                      placeholder="Select a model"
                      value={spawnerModelId}
                      onChange={setSpawnerModelId}
                      options={[
                        { label: 'None (no agent)', value: null as any },
                        ...availableModels.map(model => ({
                          label: model.name,
                          value: model.id
                        }))
                      ]}
                    />
                  </div>

                  <div style={{ marginBottom: '12px' }}>
                    <Text strong style={{ display: 'block', marginBottom: 4 }}>Props Type Name</Text>
                    <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                      TypeScript type name for the props passed to each spawned agent. Leave
                      blank to default to <Text code>{'{}'}</Text>.
                    </Text>
                    <Input
                      placeholder="{}"
                      value={spawnerPropsTypeName}
                      onChange={(e) => setSpawnerPropsTypeName(e.target.value)}
                    />
                  </div>

                  <div style={{ marginBottom: '12px' }}>
                    <Text strong style={{ display: 'block', marginBottom: 4 }}>Props Type Declarations</Text>
                    <Text type="secondary" style={{ display: 'block', marginBottom: 4, fontSize: 12 }}>
                      TypeScript type declarations that define the props type above. These will be
                      available to the agent and to code that calls the spawner.
                    </Text>
                    <Input.TextArea
                      placeholder={'type SpawnerProps = {\n  greeter: Service<Greeter>\n}'}
                      value={spawnerPropsTsTypes}
                      onChange={(e) => setSpawnerPropsTsTypes(e.target.value)}
                      rows={4}
                      style={{ fontFamily: 'monospace', fontSize: 12 }}
                    />
                  </div>

                  <div style={{ marginBottom: '12px' }}>
                    <Checkbox
                      checked={spawnerLimitEnv}
                      onChange={(e) => {
                        setSpawnerLimitEnv(e.target.checked)
                        if (!e.target.checked) {
                          setSpawnerEnv([])
                        }
                      }}
                    >
                      Limit inherited bindings
                    </Checkbox>
                    <Text type="secondary" style={{ display: 'block', marginTop: 4, fontSize: 12 }}>
                      By default, spawned agents inherit all of the gadget's bindings. Check this
                      to restrict agents to only specific bindings.
                    </Text>
                    {spawnerLimitEnv && (
                      <Select
                        mode="multiple"
                        style={{ width: '100%', marginTop: 8 }}
                        placeholder="Select bindings to inherit"
                        value={spawnerEnv}
                        onChange={setSpawnerEnv}
                        options={gatekeepers.map(g => ({
                          label: g.bindingName,
                          value: g.bindingName
                        }))}
                      />
                    )}
                  </div>
                </>
              )
            }
          ]}
        />
      </Modal>
    </div>
  )
}
