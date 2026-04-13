import { useState, useEffect, useRef } from 'react'
import { Dialog, Button, Input, Select, Tabs, Checkbox, useKumoToastManager } from '@cloudflare/kumo'
import { MagnifyingGlass } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { Overseer, GatekeeperClient, AiChatAuthorInfo, AgentSpawnerConfig } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'
import { getPlaceholderRanges, normalizeResourceUrl } from './resourceMatching'
import ResourcePicker, { type SelectableItem } from './ResourcePicker'
import { handlePickerKeyDown } from './pickerNavigation'

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
  const toasts = useKumoToastManager()

  // Tab state
  const [tabKey, setTabKey] = useState<string>('resource')

  // Shared loading flag
  const [creating, setCreating] = useState(false)

  // Resource tab state
  const [searchText, setSearchText] = useState('')

  // Picker navigation state (arrow keys, Tab, refine)
  const [overlayIndex, setOverlayIndex] = useState(0)
  const overlayItemsRef = useRef<SelectableItem[]>([])
  const overlayActivateRef = useRef<((index: number) => void) | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

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
      setSelectedModelId(undefined)
      setSpawnerDisplayName('')
      setSpawnerLimitEnv(false)
      setSpawnerEnv([])
      setOverlayIndex(0)
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
        toasts.add({ title: "Couldn't load AI models", variant: 'error' })
      })
    }
  }, [open, authenticatedApi])

  // Reset overlay index when search text changes.
  useEffect(() => {
    setOverlayIndex(0)
  }, [searchText])

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
        toasts.add({ title: 'Failed to create connection', description: 'Unsupported URL or invalid resource', variant: 'error' })
      }
    } catch (err) {
      console.error('Failed to create gatekeeper:', err)
      toasts.add({ title: 'Failed to create connection', variant: 'error' })
    } finally {
      setCreating(false)
    }
  }

  const handleCreateAiModel = async () => {
    if (!selectedModelId) {
      toasts.add({ title: 'Please select an AI model', variant: 'warning' })
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
        toasts.add({ title: 'Failed to create AI model connection', variant: 'error' })
      }
    } catch (err) {
      console.error('Failed to create AI model gatekeeper:', err)
      toasts.add({ title: 'Failed to create AI model connection', variant: 'error' })
    } finally {
      setCreating(false)
    }
  }

  const handleCreateAgentSpawner = async () => {
    if (!spawnerDisplayName.trim()) {
      toasts.add({ title: 'Please enter a display name', variant: 'warning' })
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
        toasts.add({ title: 'Failed to create agent spawner connection', variant: 'error' })
      }
    } catch (err) {
      console.error('Failed to create agent spawner gatekeeper:', err)
      toasts.add({ title: 'Failed to create agent spawner connection', variant: 'error' })
    } finally {
      setCreating(false)
    }
  }

  // --- Refine handler ---
  // Called when the user selects a prefix-match "refine" row. Replaces the search
  // text with the extended URL and selects the first placeholder.
  const handleRefine = (newUrl: string, placeholderStart: number, placeholderEnd: number) => {
    setSearchText(newUrl)
    setOverlayIndex(0)
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (input) {
        input.setSelectionRange(placeholderStart, placeholderEnd)
        input.focus()
      }
    })
  }

  // --- Footer action for non-resource tabs ---
  const handleOk = () => {
    if (tabKey === 'ai-model') {
      handleCreateAiModel()
    } else if (tabKey === 'agent-spawner') {
      handleCreateAgentSpawner()
    }
  }

  const isOkDisabled = tabKey === 'ai-model'
    ? !selectedModelId
    : !spawnerDisplayName.trim()

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog className="p-6 !w-[560px] !top-[15%] !-translate-y-0" size="lg">
        <Dialog.Title className="text-lg font-semibold mb-4">
          Create New Connection
        </Dialog.Title>

        <Tabs
          variant="segmented"
          tabs={[
            { value: 'resource', label: 'Resource' },
            { value: 'ai-model', label: 'AI Model' },
            { value: 'agent-spawner', label: 'Agent Spawner' },
          ]}
          value={tabKey}
          onValueChange={(key) => {
            setTabKey(key)
            if (key === 'resource') {
              setSearchText('')
              setOverlayIndex(0)
            }
          }}
        />

        <div className="mt-4">
          {/* ── Resource tab ──────────────────────────────────────────────── */}
          {tabKey === 'resource' && (
            <div>
              <div className="relative">
                <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive pointer-events-none" />
                <input
                  ref={inputRef}
                  placeholder="Paste a URL or search..."
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  autoFocus
                  className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-2 focus:ring-kumo-brand/40"
                  onKeyDown={(e) => {
                    handlePickerKeyDown(
                      e, searchText, 0,
                      overlayIndex, setOverlayIndex,
                      overlayItemsRef, overlayActivateRef,
                    )
                  }}
                />
              </div>
              <ResourcePicker
                authenticatedApi={authenticatedApi}
                searchText={searchText}
                onSelectAccount={(accountId, _vendorId, _resource, _accountDescription, _vendorDescription) => {
                  const url = normalizeResourceUrl(searchText)
                  if (url && getPlaceholderRanges(url).length === 0) {
                    handleCreateResource(accountId, url)
                  }
                }}
                onRefine={handleRefine}
                activeIndex={overlayIndex}
                onItems={(items) => { overlayItemsRef.current = items }}
                activateRef={overlayActivateRef}
                style={{ marginTop: 8 }}
              />
            </div>
          )}

          {/* ── AI Model tab ─────────────────────────────────────────────── */}
          {tabKey === 'ai-model' && (
            <div className="space-y-4">
              <p className="text-sm text-kumo-subtle">
                Select an AI model to create a connection. This allows your gadget to interact
                with AI capabilities as a binding.
              </p>
              <Select
                aria-label="Select an AI model"
                className="w-full text-sm"
                placeholder="Select an AI model"
                value={selectedModelId}
                onValueChange={(v) => setSelectedModelId(v as string | undefined)}
                renderValue={(id) => availableModels.find((m) => m.id === id)?.name ?? id}
              >
                {availableModels.map(model => (
                  <Select.Option key={model.id} value={model.id}>
                    {model.name}
                  </Select.Option>
                ))}
              </Select>
            </div>
          )}

          {/* ── Agent Spawner tab ────────────────────────────────────────── */}
          {tabKey === 'agent-spawner' && (
            <div className="space-y-4">
              <p className="text-sm text-kumo-subtle">
                Create an agent spawner binding. This allows your gadget to programmatically
                start new AI agent conversations to perform tasks on given resources.
              </p>

              <Input
                label="Display Name"
                placeholder="e.g. Email Responder"
                value={spawnerDisplayName}
                onChange={(e) => setSpawnerDisplayName(e.target.value)}
              />

              <div>
                <Select
                  label="Model"
                  className="w-full text-sm"
                  placeholder="Select a model"
                  value={spawnerModelId}
                  onValueChange={(v) => setSpawnerModelId(v as string | null)}
                  renderValue={(id) => {
                    if (id === null) return 'None (no agent)'
                    return availableModels.find((m) => m.id === id)?.name ?? String(id)
                  }}
                >
                  <Select.Option value={null as any}>
                    None (no agent)
                  </Select.Option>
                  {availableModels.map(model => (
                    <Select.Option key={model.id} value={model.id}>
                      {model.name}
                    </Select.Option>
                  ))}
                </Select>
                <p className="text-xs text-kumo-subtle mt-1">
                  The AI model spawned agents will use. Choose "None" to create
                  conversations without an agent (requires manual attention).
                </p>
              </div>

              <div className="space-y-2">
                <Checkbox
                  label="Limit inherited bindings"
                  checked={spawnerLimitEnv}
                  onCheckedChange={(checked) => {
                    setSpawnerLimitEnv(checked)
                    if (!checked) setSpawnerEnv([])
                  }}
                />
                <p className="text-xs text-kumo-subtle">
                  By default, spawned agents inherit all of the gadget's bindings. Check this
                  to restrict agents to only specific bindings.
                </p>
                {spawnerLimitEnv && (
                  <Select
                    aria-label="Select bindings to inherit"
                    className="w-full text-sm"
                    placeholder="Select bindings to inherit"
                    multiple
                    value={spawnerEnv}
                    onValueChange={(v) => setSpawnerEnv(v as string[])}
                  >
                    {existingBindings.map(name => (
                      <Select.Option key={name} value={name}>
                        {name}
                      </Select.Option>
                    ))}
                  </Select>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer: only show action buttons for non-resource tabs */}
        {tabKey !== 'resource' && (
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={creating}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleOk}
              disabled={isOkDisabled}
              loading={creating}
            >
              Create Connection
            </Button>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  )
}
