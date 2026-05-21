import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, useKumoToastManager } from '@cloudflare/kumo'
import {
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  Database,
  MagnifyingGlass,
  Plus,
  Robot,
  Sparkle,
  UserCircle,
  X,
} from '@phosphor-icons/react'
import { RpcStub, RpcTarget } from 'capnweb'
import {
  AgentSpawnerConfig,
  AiChatAuthorInfo,
  ConnenctedAccountsSubscriber,
  GatekeeperClient,
  Overseer,
} from '@gadgets/workshop-shared/api'
import { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { ResourceConfiguratorFrame } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from './AuthContext'
import { WorkshopButton, WorkshopIconButton } from './components/WorkshopControls'
import ResourceConfiguratorHost from './ResourceConfiguratorHost'
import { AgentSpawnerConfigForm } from './gatekeeper-modal/AgentSpawnerConfigForm'
import { AiModelConnectionConfig } from './gatekeeper-modal/AiModelConnectionConfig'

export interface GatekeeperModalProps {
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

type ConnectionTypeId =
  | 'ai-model'
  | 'agent-spawner'
  | `resource:${string}:${string}`

type ConnectionType = {
  id: ConnectionTypeId
  vendorId?: string
  // Stable grouping key used by the picker to bucket connection types. For
  // resource connections this is the vendor's stable ID (so all of Google's
  // resources land in one group). Platform types use their own `id` so that
  // each is its own single-item group instead of merging by displayName.
  groupKey: string
  // Display name shown for the group; safe to localize/change without
  // affecting grouping behavior.
  groupLabel: string
  title: string
  vendor: string
  description: string
  icon?: typeof Database
  iconUrl?: string
  logoUrl?: string
  accent?: string
  resourceUrlPattern?: string
}

type VendorOption = {
  id: string
  description: VendorDescription
  supportedResources: SupportedResource[]
}

type AccountOption = {
  id: number
  description: AccountDescription
  vendorId: string
  vendorDescription: VendorDescription
  supportedResources: SupportedResource[]
  credentialsValid: boolean
}

type ConfiguratorFrameState = {
  key: number
  frame: ResourceConfiguratorFrame
  accountId: number
  resourceUrlPattern: string
}

const PLATFORM_CONNECTION_TYPES: ConnectionType[] = [
  {
    id: 'ai-model',
    groupKey: 'platform:ai-model',
    groupLabel: 'AI Model',
    title: 'AI Model',
    vendor: 'Gadgets',
    description: 'Expose a selected model to this gadget as a capability.',
    icon: Sparkle,
    accent: '#f6edff',
  },
  {
    id: 'agent-spawner',
    groupKey: 'platform:agent-spawner',
    groupLabel: 'Agent',
    title: 'Agent',
    vendor: 'Gadgets',
    description: 'Allow this gadget to start new AI agent conversations with selected tools.',
    icon: Robot,
    accent: '#f2f0ff',
  },
]

function connectionForResource(vendor: VendorOption, resource: SupportedResource): ConnectionType {
  return {
    id: `resource:${vendor.id}:${resource.urlPattern}`,
    vendorId: vendor.id,
    // Group by stable vendor ID, not displayName, so two distinct vendors that
    // happen to share a display name don't get merged into the same group.
    groupKey: `vendor:${vendor.id}`,
    groupLabel: vendor.description.displayName,
    title: resource.title,
    vendor: vendor.description.displayName,
    description: resource.description,
    icon: Database,
    iconUrl: resource.icon?.url,
    logoUrl: vendor.description.logo?.url,
    accent: vendor.description.color,
    resourceUrlPattern: resource.urlPattern,
  }
}

function accountSupportsConnection(account: AccountOption, connection: ConnectionType): boolean {
  return account.vendorId === connection.vendorId &&
    (!connection.resourceUrlPattern ||
      connection.resourceUrlPattern === 'https://*' ||
      account.supportedResources.some(resource => resource.urlPattern === connection.resourceUrlPattern))
}

function disposeConfiguratorFrame(frame: ResourceConfiguratorFrame | null) {
  const uiDisposable = frame?.ui as any
  uiDisposable?.[Symbol.dispose]?.()
}

export default function GatekeeperModal({
  open, onClose, getOverseer, onCreated, existingBindings = [],
}: GatekeeperModalProps) {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()

  const [selectedConnectionId, setSelectedConnectionId] = useState<ConnectionTypeId | null>(null)
  const [searchText, setSearchText] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [connectingVendor, setConnectingVendor] = useState<string | null>(null)
  const [reconnectingAccountId, setReconnectingAccountId] = useState<number | null>(null)
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [vendors, setVendors] = useState<VendorOption[]>([])

  const [availableModels, setAvailableModels] = useState<AiChatAuthorInfo[]>([])
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>()

  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null)
  const [configuratorFrameState, setConfiguratorFrameState] = useState<ConfiguratorFrameState | null>(null)
  const [configuratorLoading, setConfiguratorLoading] = useState(false)
  const [configuratorError, setConfiguratorError] = useState<string | null>(null)
  const [configuratorSelectionReady, setConfiguratorSelectionReady] = useState<boolean | null>(null)
  const [dialogMinHeight, setDialogMinHeight] = useState(0)
  const headerRef = useRef<HTMLDivElement>(null)
  const footerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const [spawnerDisplayName, setSpawnerDisplayName] = useState('')
  const [spawnerModelId, setSpawnerModelId] = useState<string | null>(null)
  const [spawnerLimitEnv, setSpawnerLimitEnv] = useState(false)
  const [spawnerEnv, setSpawnerEnv] = useState<string[]>([])

  const accountSubscriptionRef = useRef<{ [Symbol.dispose](): void } | null>(null)
  const configuratorFrameRef = useRef<ConfiguratorFrameState | null>(null)
  const configuratorCollectResourceUrlRef = useRef<(() => Promise<string>) | null>(null)
  const nextConfiguratorFrameKeyRef = useRef(0)

  const updateConfiguratorFrameState = (next: ConfiguratorFrameState | null) => {
    const previous = configuratorFrameRef.current
    if (previous?.frame !== next?.frame) disposeConfiguratorFrame(previous?.frame ?? null)
    configuratorFrameRef.current = next
    if (!next) {
      configuratorCollectResourceUrlRef.current = null
      setConfiguratorSelectionReady(null)
    }
    setConfiguratorFrameState(next)
  }

  const handleConfiguratorCollectResourceUrlChange = useCallback((collect: (() => Promise<string>) | null) => {
    configuratorCollectResourceUrlRef.current = collect
  }, [])

  const allConnections = useMemo(() => [
    ...PLATFORM_CONNECTION_TYPES,
    ...vendors.flatMap(vendor => vendor.supportedResources
      .map(resource => connectionForResource(vendor, resource))),
  ], [vendors])

  const selectedConnection = useMemo(
    () => allConnections.find(connection => connection.id === selectedConnectionId) ?? null,
    [allConnections, selectedConnectionId],
  )

  useEffect(() => {
    return () => {
      disposeConfiguratorFrame(configuratorFrameRef.current?.frame ?? null)
      configuratorFrameRef.current = null
    }
  }, [])

  // Compute the dialog's min-height so its scroll container is tall enough to fit the configurator's
  // form layout without internal scrolling. Without this, in normal viewports the iframe's
  // placeholder gets clipped by the scroll container, causing the iframe contents (positioned
  // at the placeholder coords) to render on top of the modal footer. We cap this at the max
  // available height (the dialog's max-height) so that when the viewport is too short to fit
  // everything, the dialog falls back to internal scrolling (and the iframe's clip-path
  // prevents it from rendering over the footer in that case).
  useEffect(() => {
    if (!open || !selectedConnection?.resourceUrlPattern) {
      setDialogMinHeight(0)
      return
    }
    let frame = 0
    const recompute = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const header = headerRef.current?.getBoundingClientRect().height ?? 0
        const footer = footerRef.current?.getBoundingClientRect().height ?? 0
        const scroll = scrollRef.current
        if (!scroll) return setDialogMinHeight(0)
        const requested = header + footer + scroll.scrollHeight
        // Cap at the viewport-derived max-height so we don't push the dialog off-screen.
        const top = Math.max(28, Math.min(96, window.innerHeight * 0.1))
        const maxAvailable = (window.innerHeight - top - 28) * 0.9
        setDialogMinHeight(Math.ceil(Math.min(requested, maxAvailable)))
      })
    }
    recompute()
    // Observe the scroll container only; any descendant resize (including the iframe placeholder
    // growing/shrinking) changes its scrollHeight, which we re-read on each callback.
    const ro = new ResizeObserver(recompute)
    if (scrollRef.current) ro.observe(scrollRef.current)
    const onWindowResize = () => recompute()
    window.addEventListener('resize', onWindowResize)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      window.removeEventListener('resize', onWindowResize)
    }
  }, [open, selectedConnectionId])

  useEffect(() => {
    if (!open) {
      updateConfiguratorFrameState(null)
      setConfiguratorLoading(false)
      setConfiguratorError(null)
      setConfiguratorSelectionReady(null)
      return
    }

    let cancelled = false

    setSelectedConnectionId(null)
    setSearchText('')
    setExpandedGroups(new Set())
    setCreating(false)
    setConnectingVendor(null)
    setReconnectingAccountId(null)
    setVendors([])
    setSelectedAccountId(null)
    updateConfiguratorFrameState(null)
    setConfiguratorLoading(false)
    setConfiguratorError(null)
    setConfiguratorSelectionReady(null)
    setSelectedModelId(undefined)
    setSpawnerDisplayName('')
    setSpawnerModelId(null)
    setSpawnerLimitEnv(false)
    setSpawnerEnv([])

    authenticatedApi.listModels().then(models => {
      if (cancelled) return
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
      if (cancelled) return
      console.error('Failed to load models:', err)
      toasts.add({ title: "Couldn't load AI models", variant: 'error' })
    })

    authenticatedApi.listGatekeeperVendors().then(vendors => {
      if (cancelled) return
      setVendors(vendors)
    }).catch(err => {
      if (cancelled) return
      console.error('Failed to load connection vendors:', err)
      toasts.add({ title: "Couldn't load connection options", variant: 'error' })
    })

    return () => {
      cancelled = true
    }
  }, [open, authenticatedApi])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const accountMap = new Map<number, AccountOption>()

    class AccountsSubscriber extends RpcTarget implements ConnenctedAccountsSubscriber {
      add(
        id: number,
        description: AccountDescription,
        vendor: VendorDescription,
        supportedResources: SupportedResource[] = [],
        credentialsValid: boolean = true,
        vendorId: string = '',
      ) {
        if (cancelled) return
        accountMap.set(id, { id, description, vendorId, vendorDescription: vendor, supportedResources, credentialsValid })
        setAccounts(Array.from(accountMap.values()))
      }

      remove(id: number) {
        if (cancelled) return
        accountMap.delete(id)
        setAccounts(Array.from(accountMap.values()))
      }

      ready() {}
    }

    const subscriber = new AccountsSubscriber()
    authenticatedApi.subscribeConnectedAccounts(subscriber)
      .then(stub => {
        if (cancelled) {
          stub[Symbol.dispose]()
        } else {
          accountSubscriptionRef.current = stub
        }
      })
      .catch(error => {
        console.error('Failed to subscribe to connected accounts:', error)
      })

    return () => {
      cancelled = true
      accountSubscriptionRef.current?.[Symbol.dispose]()
      accountSubscriptionRef.current = null
    }
  }, [open, authenticatedApi])

  useEffect(() => {
    setSelectedAccountId(null)
    updateConfiguratorFrameState(null)
    setConfiguratorLoading(false)
    setConfiguratorError(null)
    setConfiguratorSelectionReady(null)
  }, [selectedConnectionId])

  const filteredConnections = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    if (!query) return allConnections
    return allConnections.filter(connection => {
      const haystack = [
        connection.title,
        connection.vendor,
        connection.description,
      ].join(' ').toLowerCase()
      return query.split(/\s+/).every(token => haystack.includes(token))
    })
  }, [allConnections, searchText])

  // Group connections by stable vendor key (e.g. all Google resources together).
  // Preserves the order in which a vendor's first item appears in the flat list.
  // Used to render a collapsible, grouped picker when the search box is empty.
  // Platform types (AI Model, Agent) each have their own unique groupKey so
  // they remain single-item leaves rather than collapsing into a shared
  // 'Gadgets' bucket.
  const groupedConnections = useMemo(() => {
    const groups = new Map<string, { label: string; items: ConnectionType[] }>()
    for (const connection of allConnections) {
      const key = connection.groupKey
      const existing = groups.get(key)
      if (existing) existing.items.push(connection)
      else groups.set(key, { label: connection.groupLabel, items: [connection] })
    }
    return Array.from(groups.entries()).map(([key, { label, items }]) => ({ key, label, items }))
  }, [allConnections])

  const isSearching = searchText.trim().length > 0

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const matchingAccounts = useMemo(() => {
    if (!selectedConnection?.vendorId) return []
    return accounts.filter(account => accountSupportsConnection(account, selectedConnection))
  }, [accounts, selectedConnection])

  const selectedAccount = matchingAccounts.find(
    account => account.id === selectedAccountId && account.credentialsValid,
  ) ?? null
  const needsAccount = Boolean(selectedConnection?.vendorId)

  useEffect(() => {
    if (!selectedConnection?.vendorId) return
    const currentIsValid = selectedAccountId !== null
      && matchingAccounts.some(account => account.id === selectedAccountId && account.credentialsValid)
    if (currentIsValid) return
    const firstValidAccount = matchingAccounts.find(account => account.credentialsValid)
    setSelectedAccountId(firstValidAccount?.id ?? null)
  }, [selectedConnection, matchingAccounts, selectedAccountId])

  useEffect(() => {
    const resourceUrlPattern = selectedConnection?.resourceUrlPattern ?? null
    if (!open || !resourceUrlPattern || !selectedAccount) {
      updateConfiguratorFrameState(null)
      setConfiguratorError(null)
      setConfiguratorLoading(false)
      setConfiguratorSelectionReady(null)
      return
    }

    let cancelled = false
    setConfiguratorLoading(true)
    updateConfiguratorFrameState(null)
    setConfiguratorError(null)
    setConfiguratorSelectionReady(null)

    authenticatedApi.startResourceConfigurator(selectedAccount.id, resourceUrlPattern)
      .then(frame => {
        if (cancelled) {
          disposeConfiguratorFrame(frame)
          return
        }
        updateConfiguratorFrameState({
          key: ++nextConfiguratorFrameKeyRef.current,
          frame,
          accountId: selectedAccount.id,
          resourceUrlPattern,
        })
      })
      .catch(error => {
        console.error('Failed to start resource configurator:', error)
        if (!cancelled) setConfiguratorError(error?.message || 'Could not start configurator.')
      })
      .finally(() => {
        if (!cancelled) setConfiguratorLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, authenticatedApi, selectedConnection?.id, selectedConnection?.resourceUrlPattern, selectedAccount?.id])

  const handleSelectConnection = (connection: ConnectionType) => {
    setSelectedConnectionId(connection.id)
    if (!connection.vendorId) return
    const firstValidAccount = accounts.find(account => account.credentialsValid && accountSupportsConnection(account, connection))
    if (firstValidAccount) setSelectedAccountId(firstValidAccount.id)
    else setSelectedAccountId(null)
  }

  const handleConnectAccount = async (vendorId: string) => {
    setConnectingVendor(vendorId)
    try {
      const result = await authenticatedApi.connectAccount(vendorId)
      window.open(result.url, '_blank', 'noopener,noreferrer')
      toasts.add({ title: 'Complete the account connection in the new tab.', variant: 'success' })
    } catch (error) {
      console.error('Failed to initiate connection:', error)
      toasts.add({ title: 'Failed to start connection flow', variant: 'error' })
    } finally {
      setConnectingVendor(null)
    }
  }

  const handleReconnectAccount = async (accountId: number) => {
    setReconnectingAccountId(accountId)
    try {
      const result = await authenticatedApi.reconnectAccount(accountId)
      window.open(result.url, '_blank', 'noopener,noreferrer')
      toasts.add({ title: 'Complete the account reconnect in the new tab.', variant: 'success' })
    } catch (error) {
      console.error('Failed to initiate reconnect:', error)
      toasts.add({ title: 'Failed to start reconnect flow', variant: 'error' })
    } finally {
      setReconnectingAccountId(null)
    }
  }

  const handleCreateAiModel = async () => {
    if (!selectedModelId) {
      toasts.add({ title: 'Please select an AI model', variant: 'warning' })
      return
    }
    setCreating(true)
    let gatekeeper: RpcStub<GatekeeperClient<any>> | null = null
    let transferred = false
    try {
      const overseer = await getOverseer()
      gatekeeper = await overseer.newAiModelGatekeeper(selectedModelId)
      if (gatekeeper) {
        await onCreated(gatekeeper)
        transferred = true
        onClose()
      } else {
        toasts.add({ title: 'Failed to create AI model connection', variant: 'error' })
      }
    } catch (err) {
      console.error('Failed to create AI model gatekeeper:', err)
      toasts.add({ title: 'Failed to create AI model connection', variant: 'error' })
    } finally {
      if (gatekeeper && !transferred) gatekeeper[Symbol.dispose]()
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
    let gatekeeper: RpcStub<GatekeeperClient<any>> | null = null
    let transferred = false
    try {
      const overseer = await getOverseer()
      gatekeeper = await overseer.newAgentSpawnerGatekeeper(config)
      if (gatekeeper) {
        await onCreated(gatekeeper)
        transferred = true
        onClose()
      } else {
        toasts.add({ title: 'Failed to create agent spawner connection', variant: 'error' })
      }
    } catch (err) {
      console.error('Failed to create agent spawner gatekeeper:', err)
      toasts.add({ title: 'Failed to create agent spawner connection', variant: 'error' })
    } finally {
      if (gatekeeper && !transferred) gatekeeper[Symbol.dispose]()
      setCreating(false)
    }
  }

  const handleCreateResourceConnection = async () => {
    if (creating) return
    if (!selectedConnection || selectedAccountId === null) return
    const resourceUrlPattern = selectedConnection.resourceUrlPattern
    if (!resourceUrlPattern) return

    setCreating(true)
    let gatekeeper: RpcStub<GatekeeperClient<any>> | null = null
    let transferred = false
    try {
      if (!configuratorFrameState?.frame || configuratorFrameState.accountId !== selectedAccountId || configuratorFrameState.resourceUrlPattern !== resourceUrlPattern) {
        throw new Error('Configurator is not ready.')
      }
      const resourceUrl = await configuratorCollectResourceUrlRef.current?.()
      if (!resourceUrl) throw new Error('Configurator did not provide a resource URL.')
      const overseer = await getOverseer()
      gatekeeper = await overseer.newGatekeeper(selectedAccountId, resourceUrl)
      if (gatekeeper) {
        await onCreated(gatekeeper)
        transferred = true
        onClose()
      } else {
        toasts.add({ title: 'Failed to create connection', variant: 'error' })
      }
    } catch (err) {
      console.error('Failed to create resource gatekeeper:', err)
      toasts.add({ title: err instanceof Error && err.message ? err.message : 'Failed to create connection', variant: 'error' })
    } finally {
      if (gatekeeper && !transferred) gatekeeper[Symbol.dispose]()
      setCreating(false)
    }
  }

  const canCreate = (() => {
    if (!selectedConnection) return false
    if (selectedConnection.id === 'ai-model') return Boolean(selectedModelId)
    if (selectedConnection.id === 'agent-spawner') return Boolean(spawnerDisplayName.trim())
    if (selectedConnection.resourceUrlPattern) {
      const resourceUrlPattern = selectedConnection.resourceUrlPattern
      return Boolean(
        selectedAccountId !== null &&
        resourceUrlPattern &&
        configuratorFrameState?.frame &&
        configuratorFrameState.accountId === selectedAccountId &&
        configuratorFrameState.resourceUrlPattern === resourceUrlPattern &&
        configuratorSelectionReady !== false,
      )
    }
    return false
  })()

  const handleCreate = () => {
    if (!selectedConnection) return
    if (selectedConnection.id === 'ai-model') {
      handleCreateAiModel()
    } else if (selectedConnection.id === 'agent-spawner') {
      handleCreateAgentSpawner()
    } else if (selectedConnection.resourceUrlPattern) {
      handleCreateResourceConnection()
    }
  }

  const createLabel = selectedConnection?.resourceUrlPattern
    ? 'Add connection'
    : 'Create connection'

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog
        className="!z-[1000] !top-[clamp(28px,10vh,96px)] !flex !max-h-[calc((100vh_-_clamp(28px,10vh,96px)_-_28px)_*_0.9)] !w-[min(760px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0"
        style={dialogMinHeight > 0 ? { minHeight: `${dialogMinHeight}px` } : undefined}
        size="lg"
      >
        <div ref={headerRef} className="shrink-0 flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div className="min-w-0">
            <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
              {selectedConnection ? selectedConnection.title : 'Create New Connection'}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
              {selectedConnection
                ? selectedConnection.description
                : 'Choose what this gadget should be able to use.'}
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton {...props} aria-label="Close">
                <X size={16} />
              </WorkshopIconButton>
            )}
          />
        </div>

        {selectedConnection ? (
          <div ref={scrollRef} className="new-gatekeeper-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <button
              type="button"
              onClick={() => setSelectedConnectionId(null)}
              className="mb-4 inline-flex items-center gap-1.5 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle transition-colors hover:text-kumo-default"
            >
              <CaretLeft size={13} />
              All connection types
            </button>

            <div className="space-y-4">
              {needsAccount && (
                <AccountChooser
                  accounts={matchingAccounts}
                  selectedAccountId={selectedAccountId}
                  vendorId={selectedConnection.vendorId}
                  vendorName={selectedConnection.vendor}
                  resourceTitle={selectedConnection.resourceUrlPattern ? selectedConnection.title : undefined}
                  connecting={connectingVendor === selectedConnection.vendorId}
                  reconnectingAccountId={reconnectingAccountId}
                  onSelect={setSelectedAccountId}
                  onConnect={() => selectedConnection.vendorId && handleConnectAccount(selectedConnection.vendorId)}
                  onReconnect={handleReconnectAccount}
                />
              )}

              {selectedConnection.resourceUrlPattern && (
                <ResourceConfiguratorHost
                  frame={configuratorFrameState?.frame ?? null}
                  frameKey={configuratorFrameState?.key ?? null}
                  loading={configuratorLoading}
                  error={configuratorError}
                  disabled={needsAccount && !selectedAccount}
                  onCollectResourceUrlChange={handleConfiguratorCollectResourceUrlChange}
                  onSelectionReadyChange={setConfiguratorSelectionReady}
                />
              )}

              {selectedConnection.id === 'ai-model' && (
                <AiModelConnectionConfig
                  availableModels={availableModels}
                  selectedModelId={selectedModelId}
                  onSelectedModelIdChange={setSelectedModelId}
                />
              )}

              {selectedConnection.id === 'agent-spawner' && (
                <AgentSpawnerConfigForm
                  availableModels={availableModels}
                  displayName={spawnerDisplayName}
                  modelId={spawnerModelId}
                  limitEnv={spawnerLimitEnv}
                  env={spawnerEnv}
                  existingBindings={existingBindings}
                  onDisplayNameChange={setSpawnerDisplayName}
                  onModelIdChange={setSpawnerModelId}
                  onLimitEnvChange={(checked) => {
                    setSpawnerLimitEnv(checked)
                    if (!checked) setSpawnerEnv([])
                  }}
                  onEnvChange={setSpawnerEnv}
                />
              )}


            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="shrink-0 border-b border-kumo-line bg-kumo-base px-5 py-4">
              <div className="relative">
                <MagnifyingGlass size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive" />
                <input
                  value={searchText}
                  onChange={(event) => setSearchText(event.target.value)}
                  placeholder="Search services, apps, data sources..."
                  autoFocus
                  className="h-10 w-full rounded-xl border border-kumo-line bg-kumo-base pl-9 pr-3 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive shadow-none outline-none transition-[border-color,box-shadow] focus:border-kumo-ring focus:ring-2 focus:ring-kumo-ring/10"
                />
              </div>
            </div>

            <div className="new-gatekeeper-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
                {isSearching ? (
                  filteredConnections.length === 0 ? (
                    <div className="px-4 py-8 text-center text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                      No matching connection types.
                    </div>
                  ) : filteredConnections.map((connection, index) => (
                    <ConnectionTypeRow
                      key={connection.id}
                      connection={connection}
                      first={index === 0}
                      onClick={() => handleSelectConnection(connection)}
                    />
                  ))
                ) : (
                  groupedConnections.length === 0 ? (
                    <div className="px-4 py-8 text-center text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                      No connection types available.
                    </div>
                  ) : groupedConnections.map((group, index) => (
                    <ConnectionGroupRow
                      key={group.key}
                      groupKey={group.key}
                      label={group.label}
                      items={group.items}
                      first={index === 0}
                      expanded={expandedGroups.has(group.key)}
                      onToggle={toggleGroup}
                      onSelectItem={handleSelectConnection}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {selectedConnection && (
          <div ref={footerRef} className="shrink-0 flex items-center justify-between gap-3 border-t border-kumo-line px-5 py-3">
            <div />
            <div className="flex shrink-0 items-center gap-2">
              <WorkshopButton onClick={() => setSelectedConnectionId(null)} disabled={creating} className="!h-9">
                Back
              </WorkshopButton>
              <WorkshopButton
                tone="primary"
                onClick={handleCreate}
                disabled={!canCreate || creating}
              >
                {creating ? 'Creating...' : createLabel}
              </WorkshopButton>
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  )
}

function ConnectionTypeRow({
  connection,
  first,
  onClick,
}: {
  connection: ConnectionType
  first: boolean
  onClick: () => void
}) {
  const Icon = connection.icon
  const iconUrl = connection.iconUrl ?? connection.logoUrl

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-kumo-elevated ${first ? '' : 'border-t border-kumo-line'}`}
    >
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-kumo-elevated"
        style={connection.accent ? { backgroundColor: connection.accent } : undefined}
      >
        {iconUrl ? (
          <img src={iconUrl} alt="" className="h-6 w-6 object-contain" />
        ) : Icon ? (
          <Icon size={19} weight="duotone" className="text-kumo-strong" />
        ) : (
          <Database size={19} weight="duotone" className="text-kumo-strong" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
          {connection.title}
        </p>
        <p className="mt-0.5 line-clamp-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
          {connection.vendor} · {connection.description}
        </p>
      </div>
      <CaretRight size={14} className="shrink-0 text-kumo-inactive transition-transform group-hover:translate-x-0.5 group-hover:text-kumo-default" />
    </button>
  )
}

function ConnectionGroupRow({
  groupKey,
  label,
  items,
  first,
  expanded,
  onToggle,
  onSelectItem,
}: {
  groupKey: string
  label: string
  items: ConnectionType[]
  first: boolean
  expanded: boolean
  onToggle: (key: string) => void
  onSelectItem: (connection: ConnectionType) => void
}) {
  // Defensive: the grouping memo guarantees every group has >= 1 item, but the
  // prop type can't express that. Bail out if the invariant is ever violated.
  if (items.length === 0) return null

  // If a vendor exposes exactly one connection type, the group acts as a leaf:
  // clicking the row goes straight into the selected connection rather than
  // expanding a sub-list. Multi-item groups (e.g. Google with Gmail + Docs +
  // Drive) collapse/expand to reveal their contents.
  const isSingleItem = items.length === 1
  const handleClick = () => {
    if (isSingleItem) onSelectItem(items[0])
    else onToggle(groupKey)
  }

  // Use the first item as a representative for the group's icon/logo. For
  // multi-item groups every item shares a vendorId so the logo is consistent.
  const representative = items[0]
  const Icon = representative.icon
  const Logo = logoForVendor(representative.vendorId)
  const iconUrl = !isSingleItem ? undefined : representative.iconUrl

  const subtitle = isSingleItem
    ? `${representative.vendor} · ${representative.description}`
    : items.map(item => item.title).join(', ')

  const title = isSingleItem ? representative.title : label

  return (
    <div className={first ? '' : 'border-t border-kumo-line'}>
      <button
        type="button"
        onClick={handleClick}
        aria-expanded={isSingleItem ? undefined : expanded}
        className="group flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-kumo-elevated"
      >
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-kumo-elevated"
          style={isSingleItem && representative.accent ? { backgroundColor: representative.accent } : undefined}
        >
          {iconUrl ? (
            <img src={iconUrl} alt="" className="h-full w-full object-cover" />
          ) : Logo ? (
            <Logo size={18} />
          ) : Icon ? (
            <Icon size={19} weight="duotone" className="text-kumo-strong" />
          ) : (
            <Database size={19} weight="duotone" className="text-kumo-strong" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
            {title}
          </p>
          <p className="mt-0.5 line-clamp-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
            {subtitle}
          </p>
        </div>
        {isSingleItem ? (
          <CaretRight size={14} className="shrink-0 text-kumo-inactive transition-transform group-hover:translate-x-0.5 group-hover:text-kumo-default" />
        ) : (
          <CaretDown
            size={14}
            className={`shrink-0 text-kumo-inactive transition-transform group-hover:text-kumo-default ${expanded ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      {!isSingleItem && expanded && (
        <div className="border-t border-kumo-line bg-kumo-elevated/30">
          {items.map(item => (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectItem(item)}
              className="group flex w-full items-center gap-3 border-t border-kumo-line/60 pl-10 pr-3 py-2.5 text-left transition-colors first:border-t-0 hover:bg-kumo-elevated"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-kumo-base">
                {item.iconUrl ? (
                  <img src={item.iconUrl} alt="" className="h-full w-full object-cover" />
                ) : item.icon ? (
                  <item.icon size={14} weight="duotone" className="text-kumo-strong" />
                ) : (
                  <Database size={14} weight="duotone" className="text-kumo-strong" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                  {item.title}
                </p>
                <p className="mt-0.5 line-clamp-1 text-[11.5px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                  {item.description}
                </p>
              </div>
              <CaretRight size={13} className="shrink-0 text-kumo-inactive transition-transform group-hover:translate-x-0.5 group-hover:text-kumo-default" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Renders a connected-account avatar with graceful fallback. Some vendors (notably Google) hand
// us short-lived signed CDN URLs for the user's profile photo that can stop working without the
// credentials themselves expiring; on load failure we fall back to the vendor logo, then a
// generic user icon.
function AccountAvatar({ avatarUrl, logoUrl }: { avatarUrl: string | undefined, logoUrl: string | undefined }) {
  const [failed, setFailed] = useState(false)
  if (avatarUrl && !failed) {
    return <img src={avatarUrl} alt="" className="h-full w-full object-cover" onError={() => setFailed(true)} />
  }
  if (logoUrl) return <img src={logoUrl} alt="" className="h-4 w-4 object-contain" />
  return <UserCircle size={17} className="text-kumo-subtle" />
}

function AccountChooser({
  accounts,
  selectedAccountId,
  vendorId,
  vendorName,
  resourceTitle,
  connecting,
  reconnectingAccountId,
  onSelect,
  onConnect,
  onReconnect,
}: {
  accounts: AccountOption[]
  selectedAccountId: number | null
  vendorId?: string
  vendorName: string
  resourceTitle?: string
  connecting: boolean
  reconnectingAccountId: number | null
  onSelect: (id: number) => void
  onConnect: () => void
  onReconnect: (id: number) => void
}) {
  const isEmailMailbox = vendorId === 'email' && resourceTitle === 'Email Mailbox'

  return (
    <section className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
      <div className="border-b border-kumo-line px-3 py-2.5">
        <p className="text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-default">Account</p>
        <p className="mt-0.5 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
          {isEmailMailbox
            ? 'Enable the Email receiver account, then choose the mailbox name below.'
            : `Pick which ${vendorName} identity this ${resourceTitle ?? 'connection'} should use.`}
        </p>
      </div>
      <div className="divide-y divide-kumo-line">
        {accounts.map(account => {
          const selected = selectedAccountId === account.id
          const name = account.description.uniqueName || account.description.displayName || 'Connected account'
          const expired = !account.credentialsValid
          const reconnecting = reconnectingAccountId === account.id
          return (
            <div
              key={account.id}
              className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${selected ? 'bg-kumo-tint' : ''}`}
            >
              <button
                type="button"
                disabled={expired}
                onClick={() => onSelect(account.id)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left transition-colors enabled:hover:text-kumo-default disabled:opacity-60"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-kumo-tint">
                  <AccountAvatar avatarUrl={account.description.avatar?.url} logoUrl={account.vendorDescription.logo?.url} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">{name}</p>
                  <p className="truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                    {expired
                      ? 'Expired credentials'
                      : resourceTitle ? `Connected ${vendorName} account` : account.description.scope.join(', ') || 'Connected'}
                  </p>
                </div>
                {selected && <Check size={15} weight="bold" className="shrink-0 text-kumo-brand" />}
              </button>
              {expired && (
                <button
                  type="button"
                  onClick={() => onReconnect(account.id)}
                  disabled={reconnecting}
                  className="shrink-0 rounded-md border border-kumo-line px-2 py-1 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-default transition-colors hover:bg-kumo-elevated disabled:opacity-60"
                >
                  {reconnecting ? 'Opening...' : 'Reconnect'}
                </button>
              )}
            </div>
          )
        })}

        {(!isEmailMailbox || accounts.length === 0) && (
          <button
            type="button"
            onClick={onConnect}
            disabled={connecting}
            className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle transition-colors hover:bg-kumo-elevated hover:text-kumo-default disabled:opacity-60"
          >
            {connecting ? (
              <span className="h-3.5 w-3.5 rounded-full border-2 border-kumo-brand border-t-transparent animate-spin" />
            ) : (
              <Plus size={14} />
            )}
            {isEmailMailbox
              ? 'Enable Email mailboxes'
              : accounts.length === 0 ? `Connect ${vendorName}` : `Use another ${vendorName} account`}
          </button>
        )}
      </div>
    </section>
  )
}
