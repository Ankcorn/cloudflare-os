import React from 'react'
import { Modal, Form, Select, Input, Collapse, message } from 'antd'
import { useState, useEffect } from 'react'
import { AiChatAuthorInfo, AiModelConfig, AiModelProvider, AiGatewayInfo, SUGGESTED_MODELS } from '@gadgets/workshop-shared/api'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'

const { Option, OptGroup } = Select
const { Panel } = Collapse

interface AddModelModalProps {
  visible: boolean
  onCancel: () => void
  onSuccess: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  aiConfig: AiGatewayInfo | null
}

type SelectionType =
  | { type: 'suggested', provider: AiModelProvider, modelId: string, displayName: string }
  | { type: 'custom', provider: AiModelProvider }

const PROVIDER_LABELS: Record<AiModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  cloudflare: 'Cloudflare Workers AI',
  ollama: 'Ollama',
}

export default function AddModelModal({ visible, onCancel, onSuccess, authenticatedApi, aiConfig }: AddModelModalProps) {
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)
  const [selection, setSelection] = useState<SelectionType | null>(null)

  const gatewayMode = aiConfig?.enabled === true
  const enabledProviders: Set<string> | null = gatewayMode
    ? new Set(aiConfig.enabledProviders)
    : null

  // Reset form when modal closes
  useEffect(() => {
    if (!visible) {
      form.resetFields()
      setSelection(null)
    }
  }, [visible, form])

  const handleModelSelect = (value: string) => {
    // Parse the selection value
    if (value.startsWith('other-')) {
      const provider = value.substring(6) as AiModelProvider
      setSelection({ type: 'custom', provider })
      // Reset dependent fields
      form.setFieldsValue({
        modelId: undefined,
        displayName: undefined,
        uniqueId: undefined,
        apiToken: undefined,
        apiUrl: provider === 'ollama' ? 'http://localhost:11434/api' : undefined,
      })
    } else {
      // It's a suggested model: format is "provider:modelId"
      // Only split on first colon since model IDs can contain colons (e.g., ollama's "qwen3-coder:30b")
      const colonIndex = value.indexOf(':')
      const provider = value.substring(0, colonIndex) as AiModelProvider
      const modelId = value.substring(colonIndex + 1)
      const displayName = SUGGESTED_MODELS[provider][modelId]
      setSelection({ type: 'suggested', provider, modelId, displayName })
      // Pre-fill fields for suggested models
      form.setFieldsValue({
        modelId,
        displayName,
        uniqueId: modelId,
        apiToken: undefined,
        apiUrl: provider === 'ollama' ? 'http://localhost:11434/api' : undefined,
      })
    }
  }

  const handleOk = async () => {
    try {
      const values = await form.validateFields()
      setLoading(true)

      // For suggested models, get modelId/displayName from selection state (not form)
      // since those Form.Items don't exist for suggested models
      const isSuggested = selection!.type === 'suggested'
      const modelId = isSuggested ? selection!.modelId : values.modelId
      const displayName = isSuggested ? selection!.displayName : values.displayName

      const profile: AiChatAuthorInfo = {
        type: 'agent',
        id: isSuggested ? modelId : values.uniqueId,
        name: displayName,
      }

      const config: AiModelConfig = {
        provider: selection!.provider,
        model: modelId,
        // In gateway mode, the server provides credentials; send empty token.
        apiToken: gatewayMode ? '' : (values.apiToken || ''),
        ...(!gatewayMode && values.apiUrl && { apiUrl: values.apiUrl }),
      }

      await authenticatedApi.addModel(profile, config)
      message.success('AI model added successfully')
      onSuccess()
    } catch (error: any) {
      if (error?.errorFields) {
        // Form validation error - log for debugging
        console.error('Form validation failed:', error.errorFields)
        message.error('Please fill in all required fields')
        return
      }
      console.error('Failed to add model:', error)
      message.error('Failed to add model')
    } finally {
      setLoading(false)
    }
  }

  // Build dropdown options
  const dropdownOptions: React.JSX.Element[] = []

  const providerOrder: AiModelProvider[] = Object.keys(SUGGESTED_MODELS) as AiModelProvider[];

  for (const provider of providerOrder) {
    // In gateway mode, skip providers that aren't enabled.
    if (enabledProviders && !enabledProviders.has(provider)) continue

    const models = SUGGESTED_MODELS[provider]
    const suggestedOptions: React.JSX.Element[] = []

    // In gateway mode, suggested models are already built-in, so don't list them.
    // In BYOK mode, show them as selectable options.
    if (!gatewayMode) {
      for (const [modelId, displayName] of Object.entries(models)) {
        suggestedOptions.push(
          <Option key={`${provider}:${modelId}`} value={`${provider}:${modelId}`}>
            {displayName}
          </Option>
        )
      }
    }

    // Add "Other X..." option for adding custom models from this provider
    suggestedOptions.push(
      <Option key={`other-${provider}`} value={`other-${provider}`}>
        Other {PROVIDER_LABELS[provider] || provider}...
      </Option>
    )

    dropdownOptions.push(
      <OptGroup key={provider} label={PROVIDER_LABELS[provider] || provider}>
        {suggestedOptions}
      </OptGroup>
    )
  }

  const showCustomFields = selection?.type === 'custom'
  const isOllama = selection?.provider === 'ollama'
  const isCloudflare = selection?.provider === 'cloudflare'

  // In gateway mode, all credential fields are hidden since the server manages them.
  const showCredentials = !gatewayMode

  return (
    <Modal
      title="Add AI Model"
      open={visible}
      onOk={handleOk}
      onCancel={onCancel}
      confirmLoading={loading}
      okText="Add Model"
      width={600}
    >
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 24 }}
      >
        <Form.Item
          label={gatewayMode ? "Select Provider" : "Select Model"}
          name="modelSelection"
          rules={[{ required: true, message: gatewayMode ? 'Please select a provider' : 'Please select a model' }]}
        >
          <Select
            placeholder={gatewayMode ? "Choose a provider..." : "Choose an AI model..."}
            onChange={handleModelSelect}
            showSearch
            optionFilterProp="children"
          >
            {dropdownOptions}
          </Select>
        </Form.Item>

        {showCustomFields && (
          <>
            <Form.Item
              label="Model ID"
              name="modelId"
              rules={[{ required: true, message: 'Please enter the model ID' }]}
              extra="The model identifier as specified by the provider (e.g., 'gpt-5.1-codex', 'claude-sonnet-4-5')"
            >
              <Input placeholder="e.g., gpt-5.1-codex" />
            </Form.Item>

            <Form.Item
              label="Display Name"
              name="displayName"
              rules={[{ required: true, message: 'Please enter a display name' }]}
              extra="Human-readable name shown in the UI"
            >
              <Input placeholder="e.g., ChatGPT 5.1 Codex" />
            </Form.Item>

            <Form.Item
              label="Unique ID"
              name="uniqueId"
              rules={[{ required: true, message: 'Please enter a unique ID' }]}
              extra="Unique identifier for this model configuration. Defaults to the model ID."
            >
              <Input placeholder="e.g., gpt-5.1-codex or gpt-5.1-work" />
            </Form.Item>
          </>
        )}

        {showCredentials && selection && !isCloudflare && (
          <Form.Item
            label="API Token"
            name="apiToken"
            rules={[{ required: !isOllama, message: 'Please enter your API token' }]}
            extra={isOllama ?
              'Optional for local Ollama access' :
              `Your ${PROVIDER_LABELS[selection.provider]} API token for billing`
            }
          >
            <Input placeholder={isOllama ? '(optional)' : 'sk-...'} />
          </Form.Item>
        )}

        {showCredentials && isOllama && (
          <Form.Item
            label="API URL"
            name="apiUrl"
            rules={[{ required: true, message: 'Please enter the Ollama API URL' }]}
            extra="URL of your Ollama server"
          >
            <Input placeholder="http://localhost:11434/api" />
          </Form.Item>
        )}

        {showCredentials && selection && !isOllama && !isCloudflare && (
          <Collapse ghost>
            <Panel header="Advanced Settings" key="advanced">
              <Form.Item
                label="API URL"
                name="apiUrl"
                extra="Override the default API endpoint (useful for proxies like Cloudflare AI Gateway)"
              >
                <Input placeholder="https://..." />
              </Form.Item>
            </Panel>
          </Collapse>
        )}
      </Form>
    </Modal>
  )
}
