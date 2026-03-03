import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthenticatedApi, BlueprintPublicInfo, BlueprintBinding, BlueprintBindingAssignment, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'

import { useAuth } from './useAuth'
import LoginPage from './LoginPage'
import ResourcePicker from './ResourcePicker'
import { extractBaseUrl } from './resourceMatching'
import { Card, Typography, Button, Spin, Alert, Form, Input, Select, Space, Divider, Tag, Empty } from 'antd'
import { RocketOutlined, RobotOutlined, ApiOutlined, ThunderboltOutlined, ArrowLeftOutlined, SearchOutlined } from '@ant-design/icons'

const { Title, Text, Paragraph } = Typography

interface Props {
  rpcStub: RpcStub<PublicApi>
}

// Using `any` for form state to avoid complex discriminated union issues with spread.
type BindingFormState = Record<string, any>

export default function BlueprintLandingPage({ rpcStub }: Props) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { isAuthenticated, authenticatedApi, isLoading: authLoading, login } = useAuth(rpcStub)

  const [blueprint, setBlueprint] = useState<BlueprintPublicInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [showConfigure, setShowConfigure] = useState(false)
  const [bindingForm, setBindingForm] = useState<BindingFormState>({})
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [creating, setCreating] = useState(false)
  const [showLogin, setShowLogin] = useState(false)

  // Fetch blueprint metadata.
  useEffect(() => {
    if (!id) return
    setLoading(true)
    setNotFound(false)
    setError(null)

    rpcStub.getBlueprint(id).then(result => {
      if (result) {
        setBlueprint(result)
      } else {
        setNotFound(true)
      }
    }).catch(err => {
      setError(err.message || 'Failed to load blueprint.')
    }).finally(() => {
      setLoading(false)
    })
  }, [id, rpcStub])

  // When authenticated, fetch models for binding assignment.
  useEffect(() => {
    if (isAuthenticated && authenticatedApi && showConfigure) {
      authenticatedApi.listModels().then(setModels).catch(console.error)
    }
  }, [isAuthenticated, authenticatedApi, showConfigure])

  const handleStartConfigure = () => {
    if (!isAuthenticated) {
      setShowLogin(true)
      return
    }
    setShowConfigure(true)

    // Initialize binding form state.
    if (blueprint) {
      let initial: BindingFormState = {}
      for (let [name, binding] of Object.entries(blueprint.metadata.bindings)) {
        if (binding.type === 'gatekeeper') {
          initial[name] = {
            type: 'gatekeeper',
            resourceUrl: binding.resourceUrl || '',
          } as any
        } else if (binding.type === 'aiModel') {
          initial[name] = { type: 'aiModel' } as any
        } else if (binding.type === 'agentSpawner') {
          initial[name] = { type: 'agentSpawner' } as any
        }
      }
      setBindingForm(initial)
    }
  }

  const handleLoginSuccess = () => {
    const token = localStorage.getItem('authToken')
    if (token) {
      login(token)
      setShowLogin(false)
    }
  }

  const updateBinding = (name: string, updates: Partial<BlueprintBindingAssignment>) => {
    setBindingForm(prev => ({
      ...prev,
      [name]: { ...prev[name], ...updates },
    }))
  }

  const canCreate = useCallback(() => {
    if (!blueprint) return false
    for (let [name, binding] of Object.entries(blueprint.metadata.bindings)) {
      let assignment = bindingForm[name]
      if (!assignment) return false
      if (binding.type === 'gatekeeper') {
        let a = assignment as any
        if (!a.resourceUrl || a.accountId === undefined) return false
      } else if (binding.type === 'aiModel') {
        let a = assignment as any
        if (!a.modelId) return false
      } else if (binding.type === 'agentSpawner') {
        // modelId can be null, which is valid.
        let a = assignment as any
        if (a.modelId === undefined) return false
      }
    }
    return true
  }, [blueprint, bindingForm])

  const handleCreate = async () => {
    if (!authenticatedApi || !blueprint || !id) return
    setCreating(true)
    setError(null)
    try {
      // Build assignments.
      let assignments: Record<string, BlueprintBindingAssignment> = {}
      for (let [name, binding] of Object.entries(blueprint.metadata.bindings)) {
        let form = bindingForm[name]
        if (binding.type === 'gatekeeper') {
          assignments[name] = {
            type: 'gatekeeper',
            accountId: (form as any).accountId,
            resourceUrl: (form as any).resourceUrl,
          }
        } else if (binding.type === 'aiModel') {
          assignments[name] = {
            type: 'aiModel',
            modelId: (form as any).modelId,
          }
        } else if (binding.type === 'agentSpawner') {
          assignments[name] = {
            type: 'agentSpawner',
            modelId: (form as any).modelId ?? null,
          }
        }
      }

      using overseer = await authenticatedApi.newGadgetFromBlueprint(id, assignments)
      let metadata = await overseer.getMetadata()
      navigate(`/gadget/${metadata.id}`)
    } catch (err: any) {
      setError(err.message || 'Failed to create gadget from blueprint.')
    } finally {
      setCreating(false)
    }
  }

  if (showLogin && !isAuthenticated) {
    return <LoginPage rpcStub={rpcStub} onLoginSuccess={handleLoginSuccess} />
  }

  if (loading || authLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    )
  }

  if (notFound) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Empty description="Blueprint not found" />
      </div>
    )
  }

  if (!blueprint) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Alert type="error" message={error || 'Failed to load blueprint.'} />
      </div>
    )
  }

  let meta = blueprint.metadata
  let bindingEntries = Object.entries(meta.bindings)

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#f5f5f5',
      display: 'flex',
      justifyContent: 'center',
      padding: '48px 16px',
    }}>
      <Card style={{ maxWidth: 640, width: '100%', height: 'fit-content' }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          {/* Header */}
          <div>
            <Title level={3} style={{ marginBottom: 4 }}>{meta.title}</Title>
            {meta.description && (
              <Paragraph type="secondary">{meta.description}</Paragraph>
            )}
            <Space size="small" wrap>
              <Text type="secondary">By {meta.author.name}</Text>
              <Text type="secondary">v{meta.version}</Text>
              <Text type="secondary">
                Updated {new Date(meta.lastUpdated).toLocaleDateString()}
              </Text>
            </Space>
          </div>

          {/* Bindings summary */}
          {bindingEntries.length > 0 && (
            <div>
              <Text strong>Required connections ({bindingEntries.length})</Text>
              <div style={{ marginTop: 8 }}>
                {bindingEntries.map(([name, binding]) => (
                  <div key={name} style={{
                    padding: '8px 12px',
                    background: '#fafafa',
                    borderRadius: 4,
                    marginBottom: 4,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}>
                    {binding.type === 'gatekeeper' && <ApiOutlined />}
                    {binding.type === 'aiModel' && <RobotOutlined />}
                    {binding.type === 'agentSpawner' && <ThunderboltOutlined />}
                    <div>
                      <Text code>{name}</Text>{' '}
                      <Text>{binding.title}</Text>
                      <br />
                      <Text type="secondary" style={{ fontSize: 12 }}>{binding.description}</Text>
                    </div>
                    <Tag style={{ marginLeft: 'auto' }}>{binding.type}</Tag>
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <Alert type="error" message={error} closable onClose={() => setError(null)} />}

          {/* Configure bindings */}
          {showConfigure && isAuthenticated ? (
            <div>
              <Divider />
              <Title level={5}>Configure bindings</Title>
              <Form layout="vertical">
                {bindingEntries.map(([name, binding]) => (
                  <BindingField
                    key={name}
                    name={name}
                    binding={binding}
                    value={bindingForm[name] || {}}
                    models={models}
                    authenticatedApi={authenticatedApi!}
                    onChange={(updates) => updateBinding(name, updates)}
                  />
                ))}
              </Form>
              <Button
                type="primary"
                icon={<RocketOutlined />}
                size="large"
                block
                onClick={handleCreate}
                loading={creating}
                disabled={!canCreate()}
              >
                Create Gadget
              </Button>
            </div>
          ) : (
            <Button
              type="primary"
              icon={<RocketOutlined />}
              size="large"
              block
              onClick={handleStartConfigure}
            >
              {isAuthenticated
                ? (bindingEntries.length > 0 ? 'Configure & Create Gadget' : 'Create Gadget')
                : 'Log in to create a gadget'}
            </Button>
          )}
        </Space>
      </Card>
    </div>
  )
}

// Sub-component for rendering a single binding field.
function BindingField({
  name,
  binding,
  value,
  models,
  authenticatedApi,
  onChange,
}: {
  name: string
  binding: BlueprintBinding
  value: Partial<BlueprintBindingAssignment>
  models: AiChatAuthorInfo[]
  authenticatedApi: RpcStub<AuthenticatedApi>
  onChange: (updates: Partial<BlueprintBindingAssignment>) => void
}) {
  // Local state for the gatekeeper account/URL picker.
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null)
  const [selectedAccountName, setSelectedAccountName] = useState('')
  const [selectedVendorName, setSelectedVendorName] = useState('')
  const [resourceUrlInput, setResourceUrlInput] = useState(
    () => binding.type === 'gatekeeper' ? (binding.resourceUrl || '') : ''
  )

  if (binding.type === 'gatekeeper') {
    // The URL input drives the ResourcePicker filter. Fall back to the binding's type
    // pattern so the picker still shows relevant resources when the input is empty.
    const pickerSearchText = resourceUrlInput || binding.typeUrlPattern

    return (
      <Form.Item label={<><Text code>{name}</Text> - {binding.title}</>}>
        {binding.description && (
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
            {binding.description}
          </Text>
        )}
        <Input
          placeholder="Search resources or paste a URL..."
          value={resourceUrlInput}
          onChange={(e) => {
            setResourceUrlInput(e.target.value)
            onChange({ resourceUrl: e.target.value } as any)
          }}
          allowClear
          prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
          style={{ borderRadius: 8 }}
        />

        {selectedAccountId !== null ? (
          // Account selected — show summary with option to change.
          <div style={{
            marginTop: 8, padding: '6px 8px',
            display: 'flex', alignItems: 'center', gap: 8,
            background: '#f6ffed', border: '1px solid #b7eb8f', borderRadius: 6,
          }}>
            <Button
              type="text"
              icon={<ArrowLeftOutlined />}
              size="small"
              onClick={() => {
                setSelectedAccountId(null)
                setSelectedAccountName('')
                setSelectedVendorName('')
                onChange({ accountId: undefined } as any)
              }}
            />
            <Text type="secondary" style={{ fontSize: 13 }}>
              {selectedVendorName} · <Text strong>{selectedAccountName}</Text>
            </Text>
          </div>
        ) : (
          // No account selected — show ResourcePicker filtered by the URL input.
          <ResourcePicker
            authenticatedApi={authenticatedApi}
            searchText={pickerSearchText}
            compact
            onSelectAccount={(accountId, _vendorId, resource, accountDescription, vendorDescription) => {
              setSelectedAccountId(accountId)
              setSelectedAccountName(accountDescription.uniqueName || accountDescription.displayName || 'Account')
              setSelectedVendorName(vendorDescription.displayName)

              // If the URL input is still empty, pre-fill from the blueprint suggestion
              // or the matched resource's base URL.
              if (!resourceUrlInput) {
                const url = binding.resourceUrl || extractBaseUrl(resource.urlPattern) || 'https://'
                setResourceUrlInput(url)
                onChange({ accountId, resourceUrl: url } as any)
              } else {
                onChange({ accountId } as any)
              }
            }}
            style={{ marginTop: 4 }}
          />
        )}
      </Form.Item>
    )
  }

  if (binding.type === 'aiModel') {
    return (
      <Form.Item label={<><Text code>{name}</Text> - {binding.title}</>}
        help={binding.description}>
        <Select
          placeholder="Choose an AI model"
          value={(value as any).modelId || undefined}
          onChange={(modelId) => onChange({ modelId } as any)}
          options={models.map(m => ({ label: m.name, value: m.id }))}
        />
        {binding.suggestedModel && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            Suggested: {binding.suggestedModel.provider} / {binding.suggestedModel.modelName}
          </Text>
        )}
      </Form.Item>
    )
  }

  if (binding.type === 'agentSpawner') {
    return (
      <Form.Item label={<><Text code>{name}</Text> - {binding.title}</>}
        help={binding.description}>
        <Select
          placeholder="Choose a model for the agent spawner"
          value={(value as any).modelId ?? undefined}
          onChange={(modelId) => onChange({ modelId } as any)}
          allowClear
          options={[
            { label: '(No agent)', value: null },
            ...models.map(m => ({ label: m.name, value: m.id })),
          ]}
        />
        {binding.suggestedModel !== undefined && binding.suggestedModel !== null && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            Suggested: {binding.suggestedModel.provider} / {binding.suggestedModel.modelName}
          </Text>
        )}
      </Form.Item>
    )
  }

  return null
}
