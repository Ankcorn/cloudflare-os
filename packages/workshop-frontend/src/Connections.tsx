import { useState, useEffect } from 'react'
import { Dialog, Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import {
  Pencil,
  Trash,
  Blueprint,
  Warning,
  X,
} from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { Overseer, GatekeeperMetadata, BoundHookInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import GatekeeperModal from './GatekeeperModal'
import { GatekeeperIcon } from './components/GatekeeperIcon'
import { HookToggle } from './components/HookToggle'
import { useVendorLogos } from './useVendorLogos'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from './components/WorkshopControls'
import { EmptyState } from './components/EmptyState'
import {
  BindingCardData,
  BlueprintBindingCard,
  loadBindingCardData,
} from './components/BlueprintBindingCard'

interface ConnectionsProps {
  overseer: RpcStub<Overseer>
  authenticatedApi: RpcStub<AuthenticatedApi>
  onConnectionsChange?: () => void
  isVisible?: boolean
  onHasGatekeepersChange?: (hasGatekeepers: boolean) => void
}

export default function Connections({ overseer, authenticatedApi, onConnectionsChange, isVisible: _isVisible, onHasGatekeepersChange }: ConnectionsProps) {
  const [gatekeepers, setGatekeepers] = useState<GatekeeperMetadata[]>([])
  const [hooks, setHooks] = useState<BoundHookInfo[]>([])
  const vendorLogos = useVendorLogos(authenticatedApi)
  const [loading, setLoading] = useState(true)
  const [editingGatekeeper, setEditingGatekeeper] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [isNewConnectionModalVisible, setIsNewConnectionModalVisible] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ bindingName: string; resourceTitle: string } | null>(null)
  const [deleteHookTarget, setDeleteHookTarget] = useState<{ id: number; title: string } | null>(null)
  const [togglingHooks, setTogglingHooks] = useState<Set<number>>(new Set())
  const [annotationTarget, setAnnotationTarget] = useState<GatekeeperMetadata | null>(null)
  const toasts = useKumoToastManager()

  const loadGatekeepers = async () => {
    try {
      const [gatekeeperList, hookList] = await Promise.all([
        overseer.listGatekeepers(),
        overseer.listHooks(),
      ])
      setGatekeepers(gatekeeperList)
      setHooks(hookList)
      onHasGatekeepersChange?.(gatekeeperList.length > 0)
    } catch (err) {
      console.error('Failed to load gatekeepers:', err)
      toasts.add({ title: 'Failed to load connections', variant: 'error' })
    } finally {
      setLoading(false)
    }
  }

  const handleToggleHook = async (id: number, enabled: boolean) => {
    // Optimistically reflect the new state.
    setHooks((prev) => prev.map((h) => (h.id === id ? { ...h, enabled } : h)))
    setTogglingHooks((prev) => new Set(prev).add(id))
    try {
      if (enabled) {
        await overseer.enableHook(id)
      } else {
        await overseer.disableHook(id)
      }
      await loadGatekeepers()
    } catch (err) {
      console.error('Failed to toggle hook:', err)
      toasts.add({ title: `Failed to ${enabled ? 'enable' : 'disable'} hook`, variant: 'error' })
      // Revert optimistic update.
      setHooks((prev) => prev.map((h) => (h.id === id ? { ...h, enabled: !enabled } : h)))
    } finally {
      setTogglingHooks((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const handleDeleteHookConfirm = async () => {
    if (!deleteHookTarget) return
    try {
      await overseer.deleteHook(deleteHookTarget.id)
      await loadGatekeepers()
    } catch (err) {
      console.error('Failed to delete hook:', err)
      toasts.add({ title: 'Failed to delete hook', variant: 'error' })
    } finally {
      setDeleteHookTarget(null)
    }
  }

  useEffect(() => {
    loadGatekeepers()
  }, [overseer])

  const handleEditStart = (bindingName: string) => {
    setEditingGatekeeper(bindingName)
    setEditValue(bindingName)
  }

  const handleEditSave = async (bindingName: string) => {
    if (!editValue.trim()) {
      toasts.add({ title: 'Binding name cannot be empty', variant: 'error' })
      return
    }

    let gatekeeper = null
    try {
      gatekeeper = await overseer.getGatekeeper(bindingName)
      if (gatekeeper) {
        await gatekeeper.setBindingName(editValue.trim())
        await loadGatekeepers()
        onConnectionsChange?.()
      }
    } catch (err) {
      console.error('Failed to rename gatekeeper:', err)
      toasts.add({ title: 'Failed to update binding name', variant: 'error' })
    } finally {
      gatekeeper?.[Symbol.dispose]()
      setEditingGatekeeper(null)
    }
  }

  const handleEditCancel = () => {
    setEditingGatekeeper(null)
    setEditValue('')
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    let gatekeeper = null
    try {
      gatekeeper = await overseer.getGatekeeper(deleteTarget.bindingName)
      if (gatekeeper) {
        await gatekeeper.remove()
        await loadGatekeepers()
        onConnectionsChange?.()
      }
    } catch (err) {
      console.error('Failed to delete gatekeeper:', err)
      toasts.add({ title: 'Failed to delete connection', variant: 'error' })
    } finally {
      gatekeeper?.[Symbol.dispose]()
      setDeleteTarget(null)
    }
  }

  return (
    <div className="h-full overflow-auto bg-kumo-base">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-4 py-5 sm:px-6">
        <section>
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h2 className="m-0 text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                Connections
              </h2>
              <p className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                External resources this gadget can use.
              </p>
            </div>
            <WorkshopButton
              tone="primary"
              onClick={() => setIsNewConnectionModalVisible(true)}
              className="self-start"
            >
              Connect resource
            </WorkshopButton>
          </div>

          {loading ? (
            <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-6 text-center text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
              Loading connections...
            </div>
          ) : gatekeepers.length === 0 ? (
            <EmptyState
              title="No connected resources"
              description="Connect Google Docs, GitHub, Google Sheets, and other services so this gadget can safely use external data."
              actionLabel="Connect resource"
              onAction={() => setIsNewConnectionModalVisible(true)}
            />
          ) : (
            <div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
              {gatekeepers.map((gk, index) => {
                const isEditing = editingGatekeeper === gk.bindingName
                const isDeleting = deleteTarget?.bindingName === gk.bindingName

                return (
                  <div
                    key={gk.bindingName}
                    className={`px-3 py-3 ${index > 0 ? 'border-t border-kumo-line' : ''} ${isDeleting ? 'bg-kumo-danger-tint/40' : ''}`}
                  >
                    {isDeleting ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-danger">
                            Delete {gk.resourceTitle}?
                          </p>
                          <p className="truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                            The binding <span className="font-mono">{gk.bindingName}</span> will be removed from this gadget.
                          </p>
                        </div>
                        <WorkshopButton
                          tone="danger"
                          className="min-w-[68px]"
                          onClick={handleDeleteConfirm}
                        >
                          Delete
                        </WorkshopButton>
                        <WorkshopButton
                          onClick={() => setDeleteTarget(null)}
                        >
                          Cancel
                        </WorkshopButton>
                      </div>
                    ) : isEditing ? (
                      <div className="flex items-center gap-2">
                        <WorkshopInput
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleEditSave(gk.bindingName)
                            if (e.key === 'Escape') handleEditCancel()
                          }}
                          placeholder="Binding name"
                          aria-label="Binding name"
                          autoFocus
                          className="min-w-0 flex-1 font-mono"
                        />
                        <WorkshopButton
                          tone="primary"
                          className="!h-8"
                          onClick={() => handleEditSave(gk.bindingName)}
                          disabled={!editValue.trim()}
                        >
                          Save
                        </WorkshopButton>
                        <WorkshopButton
                          onClick={handleEditCancel}
                        >
                          Cancel
                        </WorkshopButton>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <GatekeeperIcon vendorId={gk.vendorId} bindingName={gk.bindingName} logoUrl={gk.vendorId ? vendorLogos.get(gk.vendorId) : undefined} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                            {gk.resourceTitle}
                          </p>
                          <p className="mt-0.5 truncate text-[11px] leading-4 tracking-[-0.1px] text-kumo-inactive">
                            Referenced in code as: <span className="font-mono text-kumo-subtle">{gk.bindingName}</span>
                          </p>
                        </div>
                        <div className="ml-auto flex shrink-0 items-center gap-1">
                          <Tooltip content="Edit name used in code" asChild>
                            <WorkshopIconButton
                              onClick={() => handleEditStart(gk.bindingName)}
                              aria-label="Edit name used in code"
                            >
                              <Pencil size={14} />
                            </WorkshopIconButton>
                          </Tooltip>
                          <Tooltip content="Edit blueprint settings" asChild>
                            <WorkshopIconButton
                              onClick={() => setAnnotationTarget(gk)}
                              aria-label="Edit blueprint settings"
                            >
                              <Blueprint size={14} />
                            </WorkshopIconButton>
                          </Tooltip>
                          <Tooltip content="Delete connection" asChild>
                            <WorkshopIconButton
                              danger
                              onClick={() => setDeleteTarget({ bindingName: gk.bindingName, resourceTitle: gk.resourceTitle })}
                              aria-label="Delete connection"
                            >
                              <Trash size={14} />
                            </WorkshopIconButton>
                          </Tooltip>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {!loading && hooks.length > 0 && (
          <section className="mt-8">
            <div className="mb-3">
              <h2 className="m-0 text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                Hooks
              </h2>
              <p className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                Callbacks that let connected resources wake up this gadget when events happen.
              </p>
            </div>

            <div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
              {hooks.map((hook, index) => {
                const isDeleting = deleteHookTarget?.id === hook.id
                const vendorId = gatekeepers.find((g) => g.bindingName === hook.bindingName)?.vendorId

                return (
                  <div
                    key={hook.id}
                    className={`px-3 py-3 ${index > 0 ? 'border-t border-kumo-line' : ''} ${isDeleting ? 'bg-kumo-danger-tint/40' : ''}`}
                  >
                    {isDeleting ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-danger">
                            Delete hook "{hook.description.title}"?
                          </p>
                          <p className="truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                            This permanently removes the hook. Future events will stop being delivered.
                          </p>
                        </div>
                        <WorkshopButton
                          tone="danger"
                          className="min-w-[68px]"
                          onClick={handleDeleteHookConfirm}
                        >
                          Delete
                        </WorkshopButton>
                        <WorkshopButton
                          onClick={() => setDeleteHookTarget(null)}
                        >
                          Cancel
                        </WorkshopButton>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <GatekeeperIcon
                          vendorId={vendorId}
                          bindingName={hook.bindingName}
                          logoUrl={vendorId ? vendorLogos.get(vendorId) : undefined}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                            {hook.description.title}
                          </p>
                          {hook.description.description && (
                            <p className="mt-0.5 truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                              {hook.description.description}
                            </p>
                          )}
                          {(hook.resourceTitle || hook.bindingName) && (
                            <p className="mt-0.5 truncate text-[11px] leading-4 tracking-[-0.1px] text-kumo-inactive">
                              {hook.resourceTitle}
                              {hook.resourceTitle && hook.bindingName && ' · '}
                              {hook.bindingName && (
                                <span className="font-mono text-kumo-subtle">{hook.bindingName}</span>
                              )}
                            </p>
                          )}
                        </div>
                        <div className="ml-auto flex shrink-0 items-center gap-2">
                          <HookToggle
                            enabled={hook.enabled}
                            disabled={togglingHooks.has(hook.id)}
                            onToggle={(enabled) => handleToggleHook(hook.id, enabled)}
                          />
                          <Tooltip content="Delete hook" asChild>
                            <WorkshopIconButton
                              danger
                              onClick={() => setDeleteHookTarget({ id: hook.id, title: hook.description.title })}
                              aria-label="Delete hook"
                            >
                              <Trash size={14} />
                            </WorkshopIconButton>
                          </Tooltip>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </div>

      <GatekeeperModal
        open={isNewConnectionModalVisible}
        onClose={() => setIsNewConnectionModalVisible(false)}
        getOverseer={() => overseer}
        existingBindings={gatekeepers.map(g => g.bindingName)}
        onCreated={async (gk) => {
          try {
            await gk.setSuggestedBindingName()
            toasts.add({ title: 'Connection created successfully', variant: 'success' })
            await loadGatekeepers()
            onConnectionsChange?.()
          } finally {
            gk[Symbol.dispose]()
          }
        }}
      />

      <BlueprintAnnotationModal
        target={annotationTarget}
        overseer={overseer}
        onClose={() => setAnnotationTarget(null)}
        onSaved={() => {
          toasts.add({ title: 'Blueprint settings saved.', variant: 'success' })
          setAnnotationTarget(null)
        }}
      />
    </div>
  )
}

function BlueprintAnnotationModal({
  target,
  overseer,
  onClose,
  onSaved,
}: {
  target: GatekeeperMetadata | null
  overseer: RpcStub<Overseer>
  onClose: () => void
  onSaved: () => void
}) {
  const [data, setData] = useState<BindingCardData | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (!target) {
      setData(null)
      setLoadError(null)
      setSaveError(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const loaded = await loadBindingCardData(overseer, target)
        if (!cancelled) {
          if (loaded) {
            setData(loaded)
          } else {
            setLoadError('Connection not found.')
          }
        }
      } catch (err: any) {
        if (!cancelled) setLoadError(err?.message || 'Could not load binding.')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [target, overseer])

  const handleSave = async () => {
    if (!data || !target) return
    setSaving(true)
    setSaveError(null)
    let gk = null
    try {
      gk = await overseer.getGatekeeper(target.bindingName)
      if (gk) await gk.setBlueprintAnnotation(data.annotation)
      onSaved()
    } catch (err: any) {
      setSaveError(err?.message || 'Could not save.')
    } finally {
      gk?.[Symbol.dispose]()
      setSaving(false)
    }
  }

  const open = target !== null

  return (
    <>
      <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
        <Dialog className="!z-[1000] !w-[min(480px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0" size="lg">
          <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
                Blueprint settings
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                How this connection appears in blueprints.
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

          <div className="space-y-4 px-4 py-4 sm:px-5">
            {loadError ? (
              <div className="text-[13px] text-kumo-subtle">{loadError}</div>
            ) : !data ? (
              <div className="py-2 text-center text-[13px] text-kumo-subtle">Loading...</div>
            ) : (
              <>
                <BlueprintBindingCard
                  data={data}
                  onChange={(annotation) => setData({ ...data, annotation })}
                  autoFocusDescription
                  flat
                />
              </>
            )}
          </div>

          <div className="border-t border-kumo-line px-4 py-3 sm:px-5">
            {saveError && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-l-2 border-l-kumo-brand border-y-kumo-line border-r-kumo-line bg-kumo-base px-3 py-2 text-[12px] leading-[18px] font-normal tracking-[-0.2px] text-kumo-default">
                <Warning size={14} weight="fill" className="mt-0.5 shrink-0 text-kumo-brand" />
                <span>{saveError}</span>
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <WorkshopButton
                onClick={onClose}
                disabled={saving}
              >
                Cancel
              </WorkshopButton>
              <WorkshopButton
                tone="primary"
                onClick={handleSave}
                disabled={saving || !data}
              >
                {saving ? 'Saving...' : 'Save'}
              </WorkshopButton>
            </div>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  )
}
