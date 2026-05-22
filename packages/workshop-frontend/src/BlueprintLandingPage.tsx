import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { RpcStub, RpcTarget } from 'capnweb'
import { PublicApi, AuthenticatedApi, BlueprintPublicInfo, BlueprintBinding, BlueprintBindingAssignment, AiChatAuthorInfo, ConnenctedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import { AccountDescription, SupportedResource, VendorDescription, ResourceConfiguratorFrame } from '@gadgets/workshop-shared/gatekeeper'
import { Button, Dialog, Select, useKumoToastManager } from '@cloudflare/kumo'
import { Robot, Plugs, Lightning, DownloadSimple, Star, Trash } from '@phosphor-icons/react'

import { useAuth } from './useAuth'
import LoginPage from './LoginPage'
import { normalizeResourceUrl } from './resourceMatching'
import { makeBlueprintFilename, saveStreamToFile } from './fileTransfers'
import { AccountChooser, AccountOption } from './gatekeeper-modal/AccountChooser'
import ResourceConfiguratorHost from './ResourceConfiguratorHost'

interface Props {
  rpcStub: RpcStub<PublicApi>
}

// Using `any` for form state to avoid complex discriminated union issues with spread.
type BindingFormState = Record<string, any>

export default function BlueprintLandingPage({ rpcStub }: Props) {
  const params = useParams({ strict: false }) as { id?: string }
  const id = params.id!
  const navigate = useNavigate()
  const { isAuthenticated, authenticatedApi, isLoading: authLoading, login } = useAuth(rpcStub)
  const toasts = useKumoToastManager()

  const [blueprint, setBlueprint] = useState<BlueprintPublicInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [showConfigure, setShowConfigure] = useState(false)
  const [bindingForm, setBindingForm] = useState<BindingFormState>({})
  const [models, setModels] = useState<AiChatAuthorInfo[]>([])
  const [creating, setCreating] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [showLogin, setShowLogin] = useState(false)

  // Vendor catalog + connected accounts, shared by all gatekeeper bindings during configure.
  const [vendors, setVendors] = useState<{id: string, description: VendorDescription, supportedResources: SupportedResource[]}[]>([])
  const [accounts, setAccounts] = useState<AccountOption[]>([])
  const [connectingVendor, setConnectingVendor] = useState<string | null>(null)
  const [reconnectingAccountId, setReconnectingAccountId] = useState<number | null>(null)

  // Per-binding readiness flags reported by configurator iframes. A gatekeeper binding can be
  // submitted only when the iframe reports `setSelectionReady(true)` and an account is chosen.
  const [gatekeeperReady, setGatekeeperReady] = useState<Record<string, boolean>>({})

  // Per-binding URL collector functions exposed by each gatekeeper configurator iframe. We call
  // these at submit time to capture the chosen resource URL.
  const collectorsRef = useRef<Map<string, () => Promise<string>>>(new Map())
  const [canManageFeatured, setCanManageFeatured] = useState(false)
  const [isFeatured, setIsFeatured] = useState(false)
  const [updatingFeatured, setUpdatingFeatured] = useState(false)
  const [isInLibrary, setIsInLibrary] = useState(false)
  const [isUploadedBlueprint, setIsUploadedBlueprint] = useState(false)
  const [loadingLibraryState, setLoadingLibraryState] = useState(false)
  const [addingToLibrary, setAddingToLibrary] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [removingFromLibrary, setRemovingFromLibrary] = useState(false)

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

  // Load vendors (gatekeeper catalog) for the configure panel.
  useEffect(() => {
    if (!(isAuthenticated && authenticatedApi && showConfigure)) return
    let cancelled = false
    authenticatedApi.listGatekeeperVendors().then(list => {
      if (cancelled) return
      setVendors(list)
    }).catch(err => {
      if (cancelled) return
      console.error('Failed to load gatekeeper vendors:', err)
    })
    return () => { cancelled = true }
  }, [isAuthenticated, authenticatedApi, showConfigure])

  // Subscribe to connected accounts while the configure panel is open. The same subscription
  // serves all gatekeeper bindings; each binding filters down to the vendor + resource it
  // requires.
  useEffect(() => {
    if (!(isAuthenticated && authenticatedApi && showConfigure)) return
    let cancelled = false
    const accountMap = new Map<number, AccountOption>()
    let subStub: { [Symbol.dispose](): void } | null = null

    class AccountsSubscriber extends RpcTarget implements ConnenctedAccountsSubscriber {
      add(
        accountId: number,
        description: AccountDescription,
        vendor: VendorDescription,
        supportedResources: SupportedResource[] = [],
        credentialsValid: boolean = true,
        vendorId: string = '',
      ) {
        if (cancelled) return
        accountMap.set(accountId, {
          id: accountId, description, vendorId, vendorDescription: vendor,
          supportedResources, credentialsValid,
        })
        setAccounts(Array.from(accountMap.values()))
        if (credentialsValid) {
          setReconnectingAccountId(prev => prev === accountId ? null : prev)
        }
      }
      remove(accountId: number) {
        if (cancelled) return
        accountMap.delete(accountId)
        setAccounts(Array.from(accountMap.values()))
      }
      ready() {}
    }

    authenticatedApi.subscribeConnectedAccounts(new AccountsSubscriber())
      .then(stub => {
        if (cancelled) {
          stub[Symbol.dispose]()
        } else {
          subStub = stub
        }
      })
      .catch(err => {
        console.error('Failed to subscribe to connected accounts:', err)
      })

    return () => {
      cancelled = true
      subStub?.[Symbol.dispose]()
    }
  }, [isAuthenticated, authenticatedApi, showConfigure])

  const handleConnectAccount = useCallback(async (vendorId: string) => {
    if (!authenticatedApi) return
    setConnectingVendor(vendorId)
    try {
      const result = await authenticatedApi.connectAccount(vendorId)
      window.open(result.url, '_blank', 'noopener,noreferrer')
      toasts.add({ title: 'Complete the account connection in the new tab.', variant: 'success' })
    } catch (err) {
      console.error('Failed to initiate connection:', err)
      toasts.add({ title: 'Failed to start connection flow', variant: 'error' })
    } finally {
      setConnectingVendor(null)
    }
  }, [authenticatedApi, toasts])

  const handleReconnectAccount = useCallback(async (accountId: number) => {
    if (!authenticatedApi) return
    setReconnectingAccountId(accountId)
    try {
      const result = await authenticatedApi.reconnectAccount(accountId)
      window.open(result.url, '_blank', 'noopener,noreferrer')
      toasts.add({ title: 'Complete the account reconnect in the new tab.', variant: 'success' })
    } catch (err) {
      console.error('Failed to initiate reconnect:', err)
      toasts.add({ title: 'Failed to start reconnect flow', variant: 'error' })
      setReconnectingAccountId(null)
    }
  }, [authenticatedApi, toasts])

  const handleGatekeeperReadyChange = useCallback((bindingName: string, ready: boolean) => {
    setGatekeeperReady(prev => {
      if (prev[bindingName] === ready) return prev
      return { ...prev, [bindingName]: ready }
    })
  }, [])

  const handleCollectorChange = useCallback((bindingName: string, collect: (() => Promise<string>) | null) => {
    if (collect) {
      collectorsRef.current.set(bindingName, collect)
    } else {
      collectorsRef.current.delete(bindingName)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    if (!id || !authenticatedApi) {
      setCanManageFeatured(false)
      setIsFeatured(false)
      return () => {
        cancelled = true
      }
    }

    authenticatedApi.adminIsBlueprintFeatured(id).then(result => {
      if (cancelled) return

      if (result === null) {
        setCanManageFeatured(false)
        setIsFeatured(false)
      } else {
        setCanManageFeatured(true)
        setIsFeatured(result)
      }
    }).catch(err => {
      if (cancelled) return
      console.error('Failed to load admin featured state:', err)
      setCanManageFeatured(false)
      setIsFeatured(false)
    })

    return () => {
      cancelled = true
    }
  }, [id, authenticatedApi])

  useEffect(() => {
    let cancelled = false

    if (!id || !authenticatedApi) {
      setIsInLibrary(false)
      setLoadingLibraryState(false)
      return () => {
        cancelled = true
      }
    }

    setLoadingLibraryState(true)
    authenticatedApi.isBlueprintInLibrary(id).then(result => {
      if (cancelled) return
      setIsInLibrary(result !== null)
      setIsUploadedBlueprint(result?.uploaded ?? false)
    }).catch(err => {
      if (cancelled) return
      console.error('Failed to load library state:', err)
      setIsInLibrary(false)
      setIsUploadedBlueprint(false)
    }).finally(() => {
      if (!cancelled) {
        setLoadingLibraryState(false)
      }
    })

    return () => {
      cancelled = true
    }
  }, [id, authenticatedApi])

  const handleStartConfigure = () => {
    if (!isAuthenticated) {
      setShowLogin(true)
      return
    }

    // If there are no bindings to configure, create the gadget immediately.
    if (blueprint && Object.keys(blueprint.metadata.bindings).length === 0) {
      handleCreate()
      return
    }

    setShowConfigure(true)

    // Initialize binding form state. Also reset per-binding readiness flags, since the
    // configurator iframes will re-report readiness as they mount.
    setGatekeeperReady({})
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

  const updateBinding = useCallback((name: string, updates: Partial<BlueprintBindingAssignment>) => {
    setBindingForm(prev => ({
      ...prev,
      [name]: { ...prev[name], ...updates },
    }))
  }, [])

  const canCreate = useCallback(() => {
    if (!blueprint) return false
    for (let [name, binding] of Object.entries(blueprint.metadata.bindings)) {
      let assignment = bindingForm[name]
      if (!assignment) return false
      if (binding.type === 'gatekeeper') {
        let a = assignment as any
        if (a.accountId === undefined) return false
        if (!gatekeeperReady[name]) return false
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
  }, [blueprint, bindingForm, gatekeeperReady])

  const handleCreate = async () => {
    if (!authenticatedApi || !blueprint || !id) return
    setCreating(true)
    setError(null)
    try {
      // Build assignments. For gatekeeper bindings, call the iframe's `collectResourceUrl()`
      // to get the URL the user selected in the per-resource configurator UI.
      let assignments: Record<string, BlueprintBindingAssignment> = {}
      for (let [name, binding] of Object.entries(blueprint.metadata.bindings)) {
        let form = bindingForm[name]
        if (binding.type === 'gatekeeper') {
          const collect = collectorsRef.current.get(name)
          if (!collect) {
            throw new Error(`Binding "${name}" is not configured.`)
          }
          const resourceUrl = await collect()
          assignments[name] = {
            type: 'gatekeeper',
            accountId: (form as any).accountId,
            resourceUrl: normalizeResourceUrl(resourceUrl),
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
      window.location.href = `/gadget/${metadata.id}`
    } catch (err: any) {
      setError(err.message || 'Failed to create gadget from blueprint.')
    } finally {
      setCreating(false)
    }
  }

  const handleDownload = async () => {
    if (!id || !blueprint) return
    setDownloading(true)
    setError(null)

    try {
      const archive = await rpcStub.downloadBlueprint(id)
      await saveStreamToFile(
        archive,
        makeBlueprintFilename(blueprint.metadata.title, blueprint.metadata.version),
      )
    } catch (err: any) {
      setError(err.message || 'Failed to download blueprint.')
    } finally {
      setDownloading(false)
    }
  }

  const handleToggleFeatured = async () => {
    if (!authenticatedApi || !id || !canManageFeatured) return

    const nextFeatured = !isFeatured
    setUpdatingFeatured(true)

    try {
      await authenticatedApi.adminSetBlueprintFeatured(id, nextFeatured)
      setIsFeatured(nextFeatured)
    } catch (err: any) {
      console.error('Failed to update featured status:', err)
      toasts.add({
        title: nextFeatured ? 'Failed to feature blueprint' : 'Failed to unfeature blueprint',
        variant: 'error',
      })
    } finally {
      setUpdatingFeatured(false)
    }
  }

  const handleAddToLibrary = async () => {
    if (!id) return

    if (!isAuthenticated || !authenticatedApi) {
      setShowLogin(true)
      return
    }

    if (isInLibrary) {
      return
    }

    setAddingToLibrary(true)
    try {
      await authenticatedApi.addBlueprintToLibrary(id)
      setIsInLibrary(true)
      toasts.add({ title: 'Blueprint added to library', variant: 'success' })
    } catch (err) {
      console.error('Failed to add blueprint to library:', err)
      toasts.add({ title: 'Failed to add blueprint to library', variant: 'error' })
    } finally {
      setAddingToLibrary(false)
    }
  }

  const handleRemoveFromLibrary = async () => {
    if (!id || !authenticatedApi) return

    setRemovingFromLibrary(true)
    try {
      await authenticatedApi.removeBlueprintFromLibrary(id)
      if (isUploadedBlueprint) {
        setShowDeleteConfirm(false)
        toasts.add({ title: 'Blueprint deleted', variant: 'success' })
        navigate({ to: '/blueprints' })
      } else {
        setIsInLibrary(false)
        toasts.add({ title: 'Blueprint removed from library', variant: 'success' })
      }
    } catch (err) {
      console.error('Failed to remove blueprint from library:', err)
      toasts.add({
        title: isUploadedBlueprint ? 'Failed to delete blueprint' : 'Failed to remove blueprint from library',
        variant: 'error',
      })
    } finally {
      setRemovingFromLibrary(false)
    }
  }

  if (showLogin && !isAuthenticated) {
    return <LoginPage rpcStub={rpcStub} onLoginSuccess={handleLoginSuccess} />
  }

  if (loading || authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-3 border-kumo-brand border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (notFound) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-kumo-subtle text-lg">Blueprint not found</p>
      </div>
    )
  }

  if (!blueprint) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="px-4 py-3 rounded-lg bg-kumo-danger-tint border border-kumo-danger/30 text-kumo-danger text-sm">
          {error || 'Failed to load blueprint.'}
        </div>
      </div>
    )
  }

  let meta = blueprint.metadata
  let bindingEntries = Object.entries(meta.bindings)

  return (
    <div className="min-h-screen bg-kumo-elevated flex justify-center px-4 py-12">
      <div className="max-w-[640px] w-full h-fit bg-kumo-base border border-kumo-line rounded-xl p-6 shadow-sm">
        <div className="space-y-6">
          {/* Header */}
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-xl font-semibold text-kumo-default mb-1">{meta.title}</h3>
              {meta.description && (
                <p className="text-kumo-subtle text-sm mb-3">{meta.description}</p>
              )}
              <div className="flex flex-wrap items-center gap-2 text-xs text-kumo-subtle">
                <span>By {meta.author.name}</span>
                <span>v{meta.version}</span>
                <span>Updated {new Date(meta.lastUpdated).toLocaleDateString()}</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {canManageFeatured && (
                <Button
                  variant={isFeatured ? 'primary' : 'secondary'}
                  size="sm"
                  onClick={handleToggleFeatured}
                  loading={updatingFeatured}
                  icon={Star}
                >
                  {isFeatured ? 'Unfeature' : 'Feature'}
                </Button>
              )}
              {isInLibrary && isUploadedBlueprint ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowDeleteConfirm(true)}
                  icon={Trash}
                >
                  Delete blueprint
                </Button>
              ) : isInLibrary ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleRemoveFromLibrary}
                  loading={removingFromLibrary}
                  icon={Trash}
                >
                  Remove from Library
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleAddToLibrary}
                  loading={addingToLibrary || loadingLibraryState}
                >
                  {isAuthenticated ? 'Add to Library' : 'Log in to add'}
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={handleDownload}
                loading={downloading}
                icon={DownloadSimple}
              >
                Download
              </Button>
            </div>
          </div>

          {/* Bindings summary */}
          {bindingEntries.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-kumo-default mb-2">
                Required connections ({bindingEntries.length})
              </p>
              <div className="space-y-1">
                {bindingEntries.map(([name, binding]) => {
                  const title = binding.title || name
                  return (
                    <div key={name} className="flex items-center gap-2 px-3 py-2 bg-kumo-elevated rounded-md">
                      {binding.type === 'gatekeeper' && <Plugs size={14} className="text-kumo-subtle flex-shrink-0" />}
                      {binding.type === 'aiModel' && <Robot size={14} className="text-kumo-subtle flex-shrink-0" />}
                      {binding.type === 'agentSpawner' && <Lightning size={14} className="text-kumo-subtle flex-shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-kumo-default">{title}</span>
                        <span className="ml-2 text-[11px] text-kumo-inactive">Referenced in code as: <span className="font-mono text-kumo-subtle">{name}</span></span>
                        {binding.description && (
                          <>
                            <br />
                            <span className="text-xs text-kumo-subtle">{binding.description}</span>
                          </>
                        )}
                      </div>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-kumo-tint text-kumo-subtle border border-kumo-line flex-shrink-0">
                        {binding.type}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-center justify-between px-4 py-3 rounded-lg bg-kumo-danger-tint border border-kumo-danger/30 text-kumo-danger text-sm">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="text-kumo-danger hover:text-kumo-default ml-2">&times;</button>
            </div>
          )}

          {/* Configure bindings */}
          {showConfigure && isAuthenticated ? (
            <div>
              <hr className="border-kumo-line mb-4" />
              <h5 className="text-base font-semibold text-kumo-default mb-4">Configure connections</h5>
              <div className="space-y-5">
                {bindingEntries.map(([name, binding]) => (
                  <BindingField
                    key={name}
                    name={name}
                    binding={binding}
                    value={bindingForm[name] || {}}
                    models={models}
                    authenticatedApi={authenticatedApi!}
                    vendors={vendors}
                    accounts={accounts}
                    connectingVendor={connectingVendor}
                    reconnectingAccountId={reconnectingAccountId}
                    onChange={(updates) => updateBinding(name, updates)}
                    onConnectAccount={handleConnectAccount}
                    onReconnectAccount={handleReconnectAccount}
                    onReadyChange={(ready) => handleGatekeeperReadyChange(name, ready)}
                    onCollectorChange={(collect) => handleCollectorChange(name, collect)}
                  />
                ))}
              </div>
              <div className="mt-4 flex justify-end">
                <Button
                  variant="primary"
                  onClick={handleCreate}
                  loading={creating}
                  disabled={!canCreate()}
                >
                  Create Gadget
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex justify-end">
              <Button
                variant="primary"
                onClick={handleStartConfigure}
                loading={creating}
              >
                {isAuthenticated
                  ? (bindingEntries.length > 0 ? 'Configure connections' : 'Create Gadget')
                  : 'Log in to create a gadget'}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Delete uploaded blueprint confirmation dialog */}
      <Dialog.Root
        role="alertdialog"
        open={showDeleteConfirm}
        onOpenChange={(open) => { if (!open) setShowDeleteConfirm(false) }}
      >
        <Dialog className="p-8" size="sm">
          <Dialog.Title className="text-lg font-semibold">
            Delete blueprint
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-kumo-subtle">
            Delete "{blueprint?.metadata.title}"? This blueprint was uploaded manually and cannot be recovered.
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <Button variant="secondary" {...props} disabled={removingFromLibrary}>
                  Cancel
                </Button>
              )}
            />
            <Button
              variant="destructive"
              onClick={handleRemoveFromLibrary}
              loading={removingFromLibrary}
            >
              Delete
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
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
  vendors,
  accounts,
  connectingVendor,
  reconnectingAccountId,
  onChange,
  onConnectAccount,
  onReconnectAccount,
  onReadyChange,
  onCollectorChange,
}: {
  name: string
  binding: BlueprintBinding
  value: Partial<BlueprintBindingAssignment>
  models: AiChatAuthorInfo[]
  authenticatedApi: RpcStub<AuthenticatedApi>
  vendors: {id: string, description: VendorDescription, supportedResources: SupportedResource[]}[]
  accounts: AccountOption[]
  connectingVendor: string | null
  reconnectingAccountId: number | null
  onChange: (updates: Partial<BlueprintBindingAssignment>) => void
  onConnectAccount: (vendorId: string) => void
  onReconnectAccount: (accountId: number) => void
  onReadyChange: (ready: boolean) => void
  onCollectorChange: (collect: (() => Promise<string>) | null) => void
}) {
  const title = binding.title || name

  if (binding.type === 'gatekeeper') {
    return (
      <BlueprintGatekeeperBindingField
        name={name}
        title={title}
        binding={binding}
        value={value}
        authenticatedApi={authenticatedApi}
        vendors={vendors}
        accounts={accounts}
        connectingVendor={connectingVendor}
        reconnectingAccountId={reconnectingAccountId}
        onChange={onChange}
        onConnectAccount={onConnectAccount}
        onReconnectAccount={onReconnectAccount}
        onReadyChange={onReadyChange}
        onCollectorChange={onCollectorChange}
      />
    )
  }

  if (binding.type === 'aiModel') {
    return (
      <div>
        <label className="block text-sm font-medium text-kumo-default mb-1">
          {title}
        </label>
        <p className="text-[11px] text-kumo-inactive mb-1">Referenced in code as: <span className="font-mono text-kumo-subtle">{name}</span></p>
        {binding.description && (
          <p className="text-xs text-kumo-subtle mb-1">{binding.description}</p>
        )}
        <Select
          aria-label="Choose an AI model"
          className="w-full text-sm"
          placeholder="Choose an AI model"
          value={(value as any).modelId || undefined}
          onValueChange={(modelId) => onChange({ modelId } as any)}
          renderValue={(id) => models.find(m => m.id === id)?.name ?? String(id)}
        >
          {models.map(m => (
            <Select.Option key={m.id} value={m.id}>
              {m.name}
            </Select.Option>
          ))}
        </Select>
        {binding.suggestedModel && (
          <p className="text-xs text-kumo-subtle mt-1">
            Suggested: {binding.suggestedModel.provider} / {binding.suggestedModel.modelName}
          </p>
        )}
      </div>
    )
  }

  if (binding.type === 'agentSpawner') {
    return (
      <div>
        <label className="block text-sm font-medium text-kumo-default mb-1">
          {title}
        </label>
        <p className="text-[11px] text-kumo-inactive mb-1">Referenced in code as: <span className="font-mono text-kumo-subtle">{name}</span></p>
        {binding.description && (
          <p className="text-xs text-kumo-subtle mb-1">{binding.description}</p>
        )}
        <Select
          aria-label="Choose a model for the agent spawner"
          className="w-full text-sm"
          placeholder="Choose a model for the agent spawner"
          value={(value as any).modelId ?? undefined}
          onValueChange={(modelId) => onChange({ modelId } as any)}
          renderValue={(id) => {
            if (id === null) return '(No agent)'
            return models.find(m => m.id === id)?.name ?? String(id)
          }}
        >
          <Select.Option value={null as any}>(No agent)</Select.Option>
          {models.map(m => (
            <Select.Option key={m.id} value={m.id}>
              {m.name}
            </Select.Option>
          ))}
        </Select>
        {binding.suggestedModel !== undefined && binding.suggestedModel !== null && (
          <p className="text-xs text-kumo-subtle mt-1">
            Suggested: {binding.suggestedModel.provider} / {binding.suggestedModel.modelName}
          </p>
        )}
      </div>
    )
  }

  return null
}

// Dispose the host-side capability bundle returned with a configurator frame, releasing the
// gatekeeper-side resources backing the iframe.
function disposeConfiguratorFrame(frame: ResourceConfiguratorFrame | null) {
  const uiDisposable = frame?.ui as any
  uiDisposable?.[Symbol.dispose]?.()
}

// Renders the connection-wizard-style UI for a single gatekeeper binding: an account chooser
// scoped to the binding's required resource type, plus the vendor-supplied resource configurator
// iframe. The URL is collected from the iframe at submit time via `collectResourceUrl()`.
function BlueprintGatekeeperBindingField({
  name,
  title,
  binding,
  value,
  authenticatedApi,
  vendors,
  accounts,
  connectingVendor,
  reconnectingAccountId,
  onChange,
  onConnectAccount,
  onReconnectAccount,
  onReadyChange,
  onCollectorChange,
}: {
  name: string
  title: string
  binding: Extract<BlueprintBinding, { type: 'gatekeeper' }>
  value: Partial<BlueprintBindingAssignment>
  authenticatedApi: RpcStub<AuthenticatedApi>
  vendors: {id: string, description: VendorDescription, supportedResources: SupportedResource[]}[]
  accounts: AccountOption[]
  connectingVendor: string | null
  reconnectingAccountId: number | null
  onChange: (updates: Partial<BlueprintBindingAssignment>) => void
  onConnectAccount: (vendorId: string) => void
  onReconnectAccount: (accountId: number) => void
  onReadyChange: (ready: boolean) => void
  onCollectorChange: (collect: (() => Promise<string>) | null) => void
}) {
  const vendor = useMemo(
    () => vendors.find(v => v.id === binding.gatekeeperName) ?? null,
    [vendors, binding.gatekeeperName],
  )
  const resource = useMemo(
    () => vendor?.supportedResources.find(r => r.urlPattern === binding.typeUrlPattern) ?? null,
    [vendor, binding.typeUrlPattern],
  )

  const matchingAccounts = useMemo(() => accounts.filter(account =>
    account.vendorId === binding.gatekeeperName &&
    account.supportedResources.some(r => r.urlPattern === binding.typeUrlPattern)
  ), [accounts, binding.gatekeeperName, binding.typeUrlPattern])

  const selectedAccountId = (value as any).accountId ?? null
  const selectedAccount = matchingAccounts.find(a => a.id === selectedAccountId && a.credentialsValid) ?? null

  // The parent component re-renders frequently and passes us fresh inline callbacks each time.
  // Stash them in refs so effects below can call the latest versions without re-running every
  // render (which would otherwise re-spin the iframe in an infinite loop).
  const onChangeRef = useRef(onChange)
  const onReadyChangeRef = useRef(onReadyChange)
  const onCollectorChangeRef = useRef(onCollectorChange)
  useEffect(() => { onChangeRef.current = onChange }, [onChange])
  useEffect(() => { onReadyChangeRef.current = onReadyChange }, [onReadyChange])
  useEffect(() => { onCollectorChangeRef.current = onCollectorChange }, [onCollectorChange])

  // Auto-select the first valid account once accounts arrive.
  useEffect(() => {
    if (selectedAccountId !== null
        && matchingAccounts.some(a => a.id === selectedAccountId && a.credentialsValid)) {
      return
    }
    const first = matchingAccounts.find(a => a.credentialsValid)
    if (first) {
      onChangeRef.current({ accountId: first.id } as any)
    } else if (selectedAccountId !== null) {
      onChangeRef.current({ accountId: undefined } as any)
    }
  }, [matchingAccounts, selectedAccountId])

  // Configurator iframe state. We re-spin the iframe whenever the (account, resource) pair
  // changes; each frame is disposed when replaced or when the component unmounts.
  const [frameState, setFrameState] = useState<{ key: number, frame: ResourceConfiguratorFrame } | null>(null)
  const [frameLoading, setFrameLoading] = useState(false)
  const [frameError, setFrameError] = useState<string | null>(null)
  const frameRef = useRef<{ key: number, frame: ResourceConfiguratorFrame } | null>(null)
  const frameKeyRef = useRef(0)

  const replaceFrameState = useCallback((next: { key: number, frame: ResourceConfiguratorFrame } | null) => {
    const prev = frameRef.current
    if (prev?.frame !== next?.frame) disposeConfiguratorFrame(prev?.frame ?? null)
    frameRef.current = next
    setFrameState(next)
  }, [])

  // Stable callbacks for the configurator host. SandboxedResourceConfigurator's effect uses
  // `onCollectResourceUrlChange` as a dependency, so re-creating these inline each render would
  // cause the collector to briefly be unregistered (cleanup → re-register) on every parent
  // render, leaving a window where handleCreate could see an undefined collector.
  const stableOnCollectorChange = useCallback(
    (collect: (() => Promise<string>) | null) => onCollectorChangeRef.current(collect),
    [],
  )
  const stableOnReadyChange = useCallback(
    (ready: boolean | null) => onReadyChangeRef.current(ready === true),
    [],
  )

  useEffect(() => {
    return () => {
      disposeConfiguratorFrame(frameRef.current?.frame ?? null)
      frameRef.current = null
      onCollectorChangeRef.current(null)
      onReadyChangeRef.current(false)
    }
  }, [])

  useEffect(() => {
    if (!resource || !selectedAccount) {
      replaceFrameState(null)
      setFrameError(null)
      setFrameLoading(false)
      onReadyChangeRef.current(false)
      return
    }

    let cancelled = false
    setFrameLoading(true)
    setFrameError(null)
    onReadyChangeRef.current(false)
    replaceFrameState(null)

    authenticatedApi.startResourceConfigurator(selectedAccount.id, resource.urlPattern)
      .then(frame => {
        if (cancelled) {
          disposeConfiguratorFrame(frame)
          return
        }
        replaceFrameState({ key: ++frameKeyRef.current, frame })
      })
      .catch(err => {
        console.error('Failed to start resource configurator:', err)
        if (!cancelled) setFrameError(err?.message || 'Could not start configurator.')
      })
      .finally(() => {
        if (!cancelled) setFrameLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [authenticatedApi, selectedAccount?.id, resource?.urlPattern, replaceFrameState])

  // Bail out if the gatekeeper isn't installed locally or the required resource type isn't
  // offered by the vendor. The binding can't be satisfied in either case.
  if (!vendor) {
    return (
      <div className="rounded-lg border border-kumo-danger/30 bg-kumo-danger-tint px-3 py-2.5 text-sm text-kumo-danger">
        <p className="font-semibold mb-0.5">{title}</p>
        <p>The "{binding.gatekeeperName}" gatekeeper is not available on this workshop, so this connection can't be configured.</p>
      </div>
    )
  }
  if (!resource) {
    return (
      <div className="rounded-lg border border-kumo-danger/30 bg-kumo-danger-tint px-3 py-2.5 text-sm text-kumo-danger">
        <p className="font-semibold mb-0.5">{title}</p>
        <p>The required resource type for this binding isn't offered by {vendor.description.displayName}.</p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-kumo-default flex items-center gap-2">
            {title}
            <span className="text-[10px] font-normal px-1.5 py-0.5 rounded bg-kumo-tint text-kumo-subtle border border-kumo-line">
              {resource.title}
            </span>
          </p>
          <p className="text-[11px] text-kumo-inactive">Referenced in code as: <span className="font-mono text-kumo-subtle">{name}</span></p>
          {binding.description && (
            <p className="text-xs text-kumo-subtle mt-1">{binding.description}</p>
          )}
        </div>
      </div>

      <AccountChooser
        accounts={matchingAccounts}
        selectedAccountId={selectedAccountId}
        vendorId={binding.gatekeeperName}
        vendorName={vendor.description.displayName}
        resourceTitle={resource.title}
        connecting={connectingVendor === binding.gatekeeperName}
        reconnectingAccountId={reconnectingAccountId}
        onSelect={(id) => onChange({ accountId: id } as any)}
        onConnect={() => onConnectAccount(binding.gatekeeperName)}
        onReconnect={onReconnectAccount}
      />

      <ResourceConfiguratorHost
        frame={frameState?.frame ?? null}
        frameKey={frameState?.key ?? null}
        loading={frameLoading}
        error={frameError}
        disabled={!selectedAccount}
        onCollectResourceUrlChange={stableOnCollectorChange}
        onSelectionReadyChange={stableOnReadyChange}
      />
    </div>
  )
}
