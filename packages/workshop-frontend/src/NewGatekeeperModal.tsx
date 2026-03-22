import { useState, useEffect } from 'react'
import { Button, Input, Modal, Select, Tabs, Typography, Checkbox, message } from 'antd'
import { ArrowLeftOutlined, SearchOutlined } from '@ant-design/icons'
import { RpcStub } from 'capnweb'
import { Overseer, GatekeeperClient, AiChatAuthorInfo, AgentSpawnerConfig } from '@gadgets/workshop-shared/api'
import { AccountDescription } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from './AuthContext'
import { extractBaseUrl } from './resourceMatching'
import ResourcePicker from './ResourcePicker'

const { Text } = Typography

export interface NewGatekeeperModalProps {
  open: boolean
  onClose: () => void
  // Returns an overseer stub. Called only when actually creating a gatekeeper. This allows
  // the Home page to lazily provision a gadget on first use.
  getOverseer: () => Promise<RpcStub<Overseer>> | RpcStub<Overseer>
  // Called after the gatekeeper is successfully created. The caller decides what to do with
  // the stub (e.g. assign a binding name, or insert a capsule). The modal awaits this callback
  // and shows a loading state while it runs.
  onCreated: (gk: RpcStub<GatekeeperClient<any>>) => Promise<void>
  // Existing binding names, used for the Agent Spawner's "Limit inherited bindings" feature.
  existingBindings?: string[]
}

export default function NewGatekeeperModal({
  open, onClose, getOverseer, onCreated, existingBindings = [],
}: NewGatekeeperModalProps) {
  const { authenticatedApi } = useAuthenticatedApi()

  // Tab state
  const [tabKey, setTabKey] = useState<'resource' | 'ai-model' | 'agent-spawner'>('resource')

  // Shared loading flag
  const [creating, setCreating] = useState(false)

  // Resource tab state
  const [searchText, setSearchText] = useState('')
  const [selectedAccountForUrl, setSelectedAccountForUrl] = useState<number | null>(null)
  const [selectedVendorForUrl, setSelectedVendorForUrl] = useState<string | null>(null)
  const [selectedVendorName, setSelectedVendorName] = useState('')
  const [selectedAccountDescription, setSelectedAccountDescription] = useState<AccountDescription | null>(null)
  const [resourceUrlInput, setResourceUrlInput] = useState('')

  // AI Model tab state
  const [availableModels, setAvailableModels] = useState<AiChatAuthorInfo[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>()

  // Agent Spawner tab state
  const [spawnerDisplayName, setSpawnerDisplayName] = useState('')
  const [spawnerModelId, setSpawnerModelId] = useState<string | null>(null)
  const [spawnerLimitEnv, setSpawnerLimitEnv] = useState(false)
  const [spawnerEnv, setSpawnerEnv] = useState<string[]>([])

  // Reset all state when the modal opens.
  useEffect(() => {
    if (open) {
      setTabKey('resource')
      setSearchText('')
      setSelectedAccountForUrl(null)
      setSelectedVendorForUrl(null)
      setSelectedVendorName('')
      setSelectedAccountDescription(null)
      setResourceUrlInput('')
      setSelectedModelId(undefined)
      setSpawnerDisplayName('')
      setSpawnerLimitEnv(false)
      setSpawnerEnv([])
      // Load models from the user's account (doesn't require an overseer).
      authenticatedApi.listModels().then(models => {
        setAvailableModels(models)
        if (models.length > 0) {
          setSelectedModelId(models[0].id)
          const lastSelected = localStorage.getItem('lastSelectedModel')
          if (lastSelected && models.some(m => m.id === lastSelected)) {
            setSpawnerModelId(lastSelected)
          } else {
            setSpawnerModelId(models[0].id)
          }
        }
      }).catch(err => {
        console.error('Failed to load models:', err)
      })
    }
  }, [open, authenticatedApi])

  const handleBackFromUrlEntry = () => {
    setSelectedAccountForUrl(null)
    setSelectedVendorForUrl(null)
    setSelectedVendorName('')
    setSelectedAccountDescription(null)
    setResourceUrlInput('')
  }

  // --- Creation handlers ---
  // Each creates the gatekeeper, then calls onCreated() so the caller can decide what to do.

  const handleCreateResource = async (accountId: number, url: string) => {
    setCreating(true)
    try {
      const overseer = await getOverseer()
      const gatekeeper = await overseer.newGatekeeper(accountId, url)
      if (gatekeeper) {
        await onCreated(gatekeeper)
        onClose()
      } else {
        message.error('Failed to create connection - unsupported URL or invalid resource')
      }
    } catch (err) {
      console.error('Failed to create gatekeeper:', err)
      message.error('Failed to create connection')
    } finally {
      setCreating(false)
    }
  }

  const handleCreateAiModel = async () => {
    if (!selectedModelId) {
      message.error('Please select an AI model')
      return
    }
    setCreating(true)
    try {
      const overseer = await getOverseer()
      const gatekeeper = await overseer.newAiModelGatekeeper(selectedModelId)
      if (gatekeeper) {
        await onCreated(gatekeeper)
        onClose()
      } else {
        message.error('Failed to create AI model connection')
      }
    } catch (err) {
      console.error('Failed to create AI model gatekeeper:', err)
      message.error('Failed to create AI model connection')
    } finally {
      setCreating(false)
    }
  }

  const handleCreateAgentSpawner = async () => {
    if (!spawnerDisplayName.trim()) {
      message.error('Please enter a display name')
      return
    }
    const config: AgentSpawnerConfig = {
      displayName: spawnerDisplayName.trim(),
      modelId: spawnerModelId,
    }
    if (spawnerLimitEnv) config.env = spawnerEnv

    setCreating(true)
    try {
      const overseer = await getOverseer()
      const gatekeeper = await overseer.newAgentSpawnerGatekeeper(config)
      if (gatekeeper) {
        await onCreated(gatekeeper)
        onClose()
      } else {
        message.error('Failed to create agent spawner connection')
      }
    } catch (err) {
      console.error('Failed to create agent spawner gatekeeper:', err)
      message.error('Failed to create agent spawner connection')
    } finally {
      setCreating(false)
    }
  }

  // --- Rendering ---

  const renderResourceTabContent = () => {
    // Sub-step: user picked a (resource, account) pair and is entering the resource URL.
    if (selectedVendorForUrl !== null && selectedAccountForUrl !== null) {
      return (
        <div style={{ minHeight: 200 }}>
          <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Button type="text" icon={<ArrowLeftOutlined />} onClick={handleBackFromUrlEntry} size="small" />
            <Text type="secondary">
              {selectedVendorName} · <Text strong>{selectedAccountDescription?.displayName || selectedAccountDescription?.uniqueName}</Text>
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
            loading={creating}
            onClick={() => handleCreateResource(selectedAccountForUrl!, resourceUrlInput.trim())}
          >
            Create Connection
          </Button>
        </div>
      )
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
        <ResourcePicker
          authenticatedApi={authenticatedApi}
          searchText={searchText}
          onSelectAccount={(accountId, vendorId, resource, accountDescription, vendorDescription) => {
            setSelectedVendorForUrl(vendorId)
            setSelectedAccountForUrl(accountId)
            setSelectedVendorName(vendorDescription.displayName)
            setSelectedAccountDescription(accountDescription)
            const baseUrl = extractBaseUrl(resource.urlPattern) || 'https://'
            const search = searchText.trim()
            // If the user already typed a URL that extends the base pattern, keep it
            // instead of truncating (e.g. don't replace ".../documents/1234" with ".../documents/")
            if (search.length > baseUrl.length && search.toLowerCase().startsWith(baseUrl.toLowerCase())) {
              setResourceUrlInput(search)
            } else {
              setResourceUrlInput(baseUrl)
            }
          }}
          style={{ marginTop: 8 }}
        />
      </div>
    )
  }

  return (
    <Modal
      title="Create New Connection"
      open={open}
      onCancel={onClose}
      okText="Create Connection"
      cancelText="Cancel"
      confirmLoading={creating}
      focusTriggerAfterClose={false}
      okButtonProps={{
        disabled: tabKey === 'ai-model'
          ? !selectedModelId
          : !spawnerDisplayName.trim(),
      }}
      footer={tabKey === 'resource' ? null : undefined}
      onOk={() => {
        if (tabKey === 'ai-model') {
          handleCreateAiModel()
        } else if (tabKey === 'agent-spawner') {
          handleCreateAgentSpawner()
        }
      }}
    >
      <Tabs
        activeKey={tabKey}
        onChange={(key) => {
          setTabKey(key as 'resource' | 'ai-model' | 'agent-spawner')
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
                      options={existingBindings.map(name => ({
                        label: name,
                        value: name
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
  )
}
