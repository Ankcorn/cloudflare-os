import { useState, useEffect, useCallback } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { RpcStub } from 'capnweb'
import { PublicApi, AuthenticatedApi, BlueprintPublicInfo, BlueprintBinding, BlueprintBindingAssignment, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { Button, Dialog, Select, useKumoToastManager } from '@cloudflare/kumo'
import { Rocket, Robot, Plugs, Lightning, ArrowLeft, MagnifyingGlass, DownloadSimple, Star, Trash } from '@phosphor-icons/react'

import { useAuth } from './useAuth'
import LoginPage from './LoginPage'
import ResourcePicker from './ResourcePicker'
import { extractBaseUrl } from './resourceMatching'
import { makeBlueprintFilename, saveStreamToFile } from './fileTransfers'

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
                {bindingEntries.map(([name, binding]) => (
                  <div key={name} className="flex items-center gap-2 px-3 py-2 bg-kumo-elevated rounded-md">
                    {binding.type === 'gatekeeper' && <Plugs size={14} className="text-kumo-subtle flex-shrink-0" />}
                    {binding.type === 'aiModel' && <Robot size={14} className="text-kumo-subtle flex-shrink-0" />}
                    {binding.type === 'agentSpawner' && <Lightning size={14} className="text-kumo-subtle flex-shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-mono bg-kumo-tint px-1 py-0.5 rounded text-kumo-default">{name}</span>
                      {' '}
                      <span className="text-sm text-kumo-default">{binding.title}</span>
                      <br />
                      <span className="text-xs text-kumo-subtle">{binding.description}</span>
                    </div>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-kumo-tint text-kumo-subtle border border-kumo-line flex-shrink-0">
                      {binding.type}
                    </span>
                  </div>
                ))}
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
              <h5 className="text-base font-semibold text-kumo-default mb-4">Configure bindings</h5>
              <div className="space-y-5">
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
              </div>
              <Button
                className="w-full mt-4"
                variant="primary"
                onClick={handleCreate}
                loading={creating}
                disabled={!canCreate()}
                icon={Rocket}
              >
                Create Gadget
              </Button>
            </div>
          ) : (
            <Button
              className="w-full"
              variant="primary"
              onClick={handleStartConfigure}
              icon={Rocket}
            >
              {isAuthenticated
                ? (bindingEntries.length > 0 ? 'Configure & Create Gadget' : 'Create Gadget')
                : 'Log in to create a gadget'}
            </Button>
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
      <div>
        <label className="block text-sm font-medium text-kumo-default mb-1">
          <span className="text-xs font-mono bg-kumo-tint px-1 py-0.5 rounded">{name}</span>
          {' '}- {binding.title}
        </label>
        {binding.description && (
          <p className="text-xs text-kumo-subtle mb-2">{binding.description}</p>
        )}
        <div className="relative">
          <MagnifyingGlass size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive" />
          <input
            type="text"
            placeholder="Search resources or paste a URL..."
            value={resourceUrlInput}
            onChange={(e) => {
              setResourceUrlInput(e.target.value)
              onChange({ resourceUrl: e.target.value } as any)
            }}
            className="w-full pl-9 pr-3 py-2 text-sm border border-kumo-line rounded-lg bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:border-kumo-brand"
          />
        </div>

        {selectedAccountId !== null ? (
          // Account selected — show summary with option to change.
          <div className="mt-2 px-2 py-1.5 flex items-center gap-2 bg-green-50 border border-green-200 rounded-md">
            <button
              onClick={() => {
                setSelectedAccountId(null)
                setSelectedAccountName('')
                setSelectedVendorName('')
                onChange({ accountId: undefined } as any)
              }}
              className="p-1 rounded hover:bg-green-100 text-kumo-subtle transition-colors"
            >
              <ArrowLeft size={14} />
            </button>
            <span className="text-[13px] text-kumo-subtle">
              {selectedVendorName} · <span className="font-semibold text-kumo-default">{selectedAccountName}</span>
            </span>
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
      </div>
    )
  }

  if (binding.type === 'aiModel') {
    return (
      <div>
        <label className="block text-sm font-medium text-kumo-default mb-1">
          <span className="text-xs font-mono bg-kumo-tint px-1 py-0.5 rounded">{name}</span>
          {' '}- {binding.title}
        </label>
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
          <span className="text-xs font-mono bg-kumo-tint px-1 py-0.5 rounded">{name}</span>
          {' '}- {binding.title}
        </label>
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
