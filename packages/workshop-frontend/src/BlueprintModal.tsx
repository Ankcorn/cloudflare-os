import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Dialog, useKumoToastManager } from '@cloudflare/kumo'
import { ArrowsClockwise, Check, Copy, Pencil, Plus, Trash, Warning, X } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { BlueprintGadgetSummary, GadgetMetadata, GatekeeperMetadata, Overseer, BlueprintBindingAnnotation } from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton, WorkshopInput, WorkshopInputArea } from './components/WorkshopControls'
import { copyToClipboard } from './clipboard'
import {
  BindingCardData,
  BlueprintBindingCard,
  loadBindingCardData,
} from './components/BlueprintBindingCard'

type Props = {
  open: boolean
  onClose: () => void
  overseer: RpcStub<Overseer>
  metadata: GadgetMetadata
}

export default function BlueprintModal({ open, onClose, overseer, metadata }: Props) {
  const toasts = useKumoToastManager()

  const [blueprints, setBlueprints] = useState<BlueprintGadgetSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitleValue, setEditTitleValue] = useState('')
  const [editDescriptionValue, setEditDescriptionValue] = useState('')
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const [bindings, setBindings] = useState<BindingCardData[]>([])
  const [bindingsLoading, setBindingsLoading] = useState(false)
  const [bindingsError, setBindingsError] = useState<string | null>(null)

  const loadBlueprints = useCallback(async () => {
    setLoading(true)
    try {
      setBlueprints(await overseer.listBlueprints())
    } catch (err) {
      console.error('Failed to load blueprints:', err)
      toasts.add({ title: 'Failed to load blueprints', variant: 'error' })
    } finally {
      setLoading(false)
    }
  }, [overseer])

  const loadBindings = useCallback(async () => {
    setBindingsLoading(true)
    setBindingsError(null)
    try {
      const list = await overseer.listGatekeepers()
      const named = list.filter((g: GatekeeperMetadata) => g.bindingName)
      const loaded = await Promise.all(named.map((g) => loadBindingCardData(overseer, g)))
      setBindings(loaded.filter((b): b is BindingCardData => b !== null))
    } catch (err) {
      console.error('Failed to load bindings:', err)
      setBindingsError('Could not load connections.')
    } finally {
      setBindingsLoading(false)
    }
  }, [overseer])

  useEffect(() => {
    if (open) {
      loadBlueprints()
      setShowCreateForm(false)
      setNewTitle(metadata.title)
      setNewDescription('')
      setCreateError(null)
    }
  }, [open, loadBlueprints, metadata.title])

  useEffect(() => {
    if (showCreateForm) {
      loadBindings()
    } else {
      setBindings([])
      setBindingsError(null)
      setCreateError(null)
    }
  }, [showCreateForm, loadBindings])

  const updateBindingAnnotation = (bindingName: string, annotation: BlueprintBindingAnnotation) => {
    setBindings((prev) =>
      prev.map((b) => (b.bindingName === bindingName ? { ...b, annotation } : b)),
    )
  }

  const createBlueprint = async () => {
    if (bindingsLoading) return
    setCreating(true)
    setCreateError(null)
    try {
      await Promise.all(
        bindings.map(async (b) => {
          using gk = await overseer.getGatekeeper(b.bindingName)
          if (gk) await gk.setBlueprintAnnotation(b.annotation)
        }),
      )

      await overseer.createBlueprint(
        newTitle.trim() || undefined,
        newDescription.trim() || undefined,
      )
      toasts.add({ title: 'Blueprint created.', variant: 'success' })
      setShowCreateForm(false)
      setNewTitle(metadata.title)
      setNewDescription('')
      await loadBlueprints()
    } catch (err: any) {
      setCreateError(err.message || 'Could not create blueprint.')
    } finally {
      setCreating(false)
    }
  }

  const deleteBlueprint = async (id: string) => {
    setDeletingId(id)
    try {
      await overseer.deleteBlueprint(id)
      toasts.add({ title: 'Blueprint deleted.', variant: 'success' })
      setConfirmingDeleteId(null)
      await loadBlueprints()
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to delete blueprint.', variant: 'error' })
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog className="!z-[1000] !w-[min(640px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0 !top-[10%] !-translate-y-0" size="lg">
          <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-4 py-5 sm:px-6">
            <div className="flex min-w-0 items-start gap-3">
              <div className="min-w-0">
              <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                {showCreateForm ? 'Create blueprint' : 'Blueprints'}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                {showCreateForm
                  ? 'Describe what people get when they start from this blueprint.'
                  : 'Turn this gadget into a reusable starting point.'}
              </Dialog.Description>
              </div>
            </div>
            <Dialog.Close
              render={(props) => (
                <WorkshopIconButton
                  {...props}
                  aria-label="Close"
                >
                  <X size={18} />
                </WorkshopIconButton>
              )}
            />
          </div>

          <div
            className={showCreateForm ? 'flex flex-col' : ''}
            style={showCreateForm ? { maxHeight: 'calc(80vh - 80px)' } : undefined}
          >
            {showCreateForm ? (
              <>
                <div className="flex-1 overflow-y-auto chat-panel space-y-5 px-4 py-5 sm:px-6">
                  <div className="space-y-3">
                    <WorkshopInput
                      placeholder="Title"
                      aria-label="Blueprint title"
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      className="w-full"
                    />
                    <WorkshopInputArea
                      placeholder="Description (optional)"
                      aria-label="Blueprint description"
                      value={newDescription}
                      onChange={(e) => setNewDescription(e.target.value)}
                      rows={3}
                      className="w-full"
                    />
                  </div>

                  {bindingsLoading ? (
                    <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-6 text-center text-[13px] text-kumo-subtle">
                      Loading connections...
                    </div>
                  ) : bindingsError ? (
                    <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-3 text-[13px] text-kumo-subtle">
                      {bindingsError}
                    </div>
                  ) : bindings.length > 0 ? (
                    <section>
                      <h3 className="m-0 mb-1 text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                        Connections
                      </h3>
                      <p className="m-0 mb-3 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                        Name each connection and add guidance for people using this blueprint.
                      </p>
                      <div className="space-y-2">
                        {bindings.map((b) => (
                          <BlueprintBindingCard
                            key={b.bindingName}
                            data={b}
                            onChange={(annotation) => updateBindingAnnotation(b.bindingName, annotation)}
                          />
                        ))}
                      </div>
                    </section>
                  ) : null}
                </div>

                <div className="border-t border-kumo-line px-4 py-4 sm:px-6">
                  {createError && (
                    <div className="mb-3 flex items-start gap-2 rounded-lg border border-l-2 border-l-kumo-brand border-y-kumo-line border-r-kumo-line bg-kumo-base px-3 py-2 text-[12px] leading-[18px] font-normal tracking-[-0.2px] text-kumo-default">
                      <Warning size={14} weight="fill" className="mt-0.5 shrink-0 text-kumo-brand" />
                      <span>{createError}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <WorkshopButton
                      className="!h-9 min-w-[64px]"
                      onClick={() => setShowCreateForm(false)}
                      disabled={creating}
                    >
                      Back
                    </WorkshopButton>
                    <WorkshopButton
                      tone="primary"
                      className="min-w-[64px]"
                      onClick={createBlueprint}
                      disabled={creating || bindingsLoading}
                    >
                      {creating ? 'Creating...' : bindingsLoading ? 'Loading...' : 'Create'}
                    </WorkshopButton>
                  </div>
                </div>
              </>
            ) : (
              <div className="space-y-4 px-4 py-5 sm:px-6">
              <button
                type="button"
                onClick={() => {
                  setNewTitle(metadata.title)
                  setShowCreateForm(true)
                }}
                className="flex w-full items-center justify-between rounded-xl border border-kumo-line bg-kumo-base px-4 py-3 text-left transition-colors hover:bg-kumo-elevated"
              >
                <span>
                  <span className="block text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                    Create blueprint
                  </span>
                  <span className="mt-0.5 block text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                    Publish this gadget as a reusable template.
                  </span>
                </span>
                <Plus size={16} className="text-kumo-subtle" />
              </button>

            <section>
              <h3 className="mb-2 text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                Existing blueprints
              </h3>

              {loading ? (
                <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-6 text-center text-[13px] text-kumo-subtle">
                  Loading blueprints...
                </div>
              ) : blueprints.length === 0 ? (
                <div className="rounded-xl border border-dashed border-kumo-line bg-kumo-base px-4 py-6 text-center">
                  <p className="text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                    No blueprints yet.
                  </p>
                </div>
              ) : (
                <div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
                  {blueprints.map((bp, index) => (
                    <BlueprintRow
                      key={bp.id}
                      bp={bp}
                      isFirst={index === 0}
                      isEditing={editingId === bp.id}
                      editTitleValue={editTitleValue}
                      editDescriptionValue={editDescriptionValue}
                      onStartEdit={() => {
                        setEditingId(bp.id)
                        setEditTitleValue(bp.title)
                        setEditDescriptionValue(bp.description)
                      }}
                      onChangeEditTitle={setEditTitleValue}
                      onChangeEditDescription={setEditDescriptionValue}
                      onSaveEdit={async () => {
                        const title = editTitleValue.trim()
                        if (!title) {
                          setEditingId(null)
                          return
                        }
                        try {
                          await overseer.updateBlueprint(bp.id, {
                            title,
                            description: editDescriptionValue,
                          })
                          setEditingId(null)
                          loadBlueprints()
                        } catch (err: any) {
                          toasts.add({ title: err.message || 'Failed to update blueprint.', variant: 'error' })
                        }
                      }}
                      onCancelEdit={() => setEditingId(null)}
                      onUpdateCode={async () => {
                        try {
                          await overseer.updateBlueprint(bp.id, { updateCode: true })
                          toasts.add({ title: 'Blueprint updated to current code.', variant: 'success' })
                          loadBlueprints()
                        } catch (err: any) {
                          toasts.add({ title: err.message || 'Failed to update blueprint.', variant: 'error' })
                        }
                      }}
                      onRetryPublish={async () => {
                        try {
                          await overseer.retryBlueprintPublish(bp.id)
                          toasts.add({ title: 'Blueprint published successfully.', variant: 'success' })
                          loadBlueprints()
                        } catch (err: any) {
                          toasts.add({ title: err.message || 'Retry failed.', variant: 'error' })
                        }
                      }}
                      onCopyLink={async () => {
                        const url = `${window.location.origin}/blueprint/${bp.id}`
                        return copyToClipboard(url)
                      }}
                      isConfirmingDelete={confirmingDeleteId === bp.id}
                      isDeleting={deletingId === bp.id}
                      onStartDelete={() => setConfirmingDeleteId(bp.id)}
                      onConfirmDelete={() => deleteBlueprint(bp.id)}
                      onCancelDelete={() => setConfirmingDeleteId(null)}
                    />
                  ))}
                </div>
              )}
            </section>
              </div>
            )}
          </div>
      </Dialog>
    </Dialog.Root>
  )
}

function BlueprintRow({
  bp,
  isFirst,
  isEditing,
  editTitleValue,
  editDescriptionValue,
  onStartEdit,
  onChangeEditTitle,
  onChangeEditDescription,
  onSaveEdit,
  onCancelEdit,
  onUpdateCode,
  onRetryPublish,
  onCopyLink,
  isConfirmingDelete,
  isDeleting,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  bp: BlueprintGadgetSummary
  isFirst: boolean
  isEditing: boolean
  editTitleValue: string
  editDescriptionValue: string
  onStartEdit: () => void
  onChangeEditTitle: (value: string) => void
  onChangeEditDescription: (value: string) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onUpdateCode: () => void
  onRetryPublish: () => void
  onCopyLink: () => Promise<boolean>
  isConfirmingDelete: boolean
  isDeleting: boolean
  onStartDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (copyState === 'idle') return
    const t = setTimeout(() => setCopyState('idle'), 1500)
    return () => clearTimeout(t)
  }, [copyState])

  const ROW_MIN_H = 'min-h-[116px]'
  if (isConfirmingDelete) {
    return (
      <div
        className={`flex items-center px-4 py-4 ${ROW_MIN_H} ${isFirst ? '' : 'border-t border-kumo-line'} bg-kumo-danger-tint/40`}
      >
        <div className="flex w-full flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="m-0 truncate text-[14px] leading-5 font-semibold tracking-[-0.3px] text-kumo-danger">
              Delete "{bp.title}"?
            </p>
            <p className="m-0 mt-0.5 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              People who started a gadget from this blueprint won't be affected, but the link will stop working.
            </p>
          </div>
          <button
            type="button"
            onClick={onConfirmDelete}
            disabled={isDeleting}
            className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md bg-kumo-danger px-2.5 text-[12px] leading-4 font-medium tracking-[-0.2px] text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isDeleting ? 'Deleting...' : 'Delete'}
          </button>
          <button
            type="button"
            onClick={onCancelDelete}
            disabled={isDeleting}
            className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-md bg-transparent px-2.5 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`group/row relative px-4 py-4 ${ROW_MIN_H} ${isFirst ? '' : 'border-t border-kumo-line'}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        {isEditing ? (
          <input
            autoFocus
            type="text"
            aria-label="Blueprint title"
            value={editTitleValue}
            onChange={(e) => onChangeEditTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onSaveEdit()
              }
              if (e.key === 'Escape') onCancelEdit()
            }}
            placeholder="Untitled"
            className="m-0 block min-w-0 flex-1 border-0 bg-transparent p-0 text-[15px] leading-5 font-semibold tracking-[-0.3px] text-kumo-default placeholder:text-kumo-inactive shadow-none outline-none focus:outline-none focus:ring-0"
          />
        ) : (
          <p className="m-0 min-w-0 flex-1 truncate text-[15px] leading-5 font-semibold tracking-[-0.3px] text-kumo-default">
            {bp.title}
          </p>
        )}

        <span
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-semibold tracking-[-0.1px] ${
            bp.dirty
              ? 'border-kumo-brand/25 bg-kumo-brand/10 text-kumo-brand'
              : 'border-kumo-line bg-kumo-tint text-kumo-subtle'
          }`}
          title={bp.dirty ? 'Last publish failed' : undefined}
        >
          {bp.dirty && (
            <span
              className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-kumo-brand"
              aria-hidden="true"
            />
          )}
          v{bp.version} · {new Date(bp.codeVersionDate).toLocaleDateString()}
        </span>
      </div>

      <div className="mt-1.5 min-h-[18px]">
        {isEditing ? (
          <AutosizingTextarea
            value={editDescriptionValue}
            onChange={onChangeEditDescription}
            onCommit={onSaveEdit}
            onCancel={onCancelEdit}
          />
        ) : bp.description ? (
          <p className="m-0 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle whitespace-pre-wrap">
            {bp.description}
          </p>
        ) : (
          <p className="m-0 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-inactive">
            No description
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        {isEditing ? (
          <>
            <span aria-hidden="true" />
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={onCancelEdit}
                className="inline-flex h-7 cursor-pointer items-center rounded-md bg-transparent px-2.5 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onSaveEdit}
                disabled={!editTitleValue.trim()}
                className="inline-flex h-7 cursor-pointer items-center rounded-md bg-kumo-contrast px-2.5 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-inverse transition-colors hover:bg-kumo-strong disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-kumo-contrast"
              >
                Save
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="-ml-[7px] flex flex-wrap items-center gap-1">
              <GhostButton onClick={onUpdateCode} icon={<ArrowsClockwise size={13} />}>
                Update code
              </GhostButton>
              {bp.dirty && (
                <GhostButton onClick={onRetryPublish} icon={<ArrowsClockwise size={13} />}>
                  Retry publish
                </GhostButton>
              )}
              <GhostButton
                onClick={async () => {
                  setCopyState(await onCopyLink() ? 'copied' : 'failed')
                }}
                icon={
                  copyState === 'copied' ? (
                    <Check size={13} className="text-kumo-success" />
                  ) : (
                    <Copy size={13} />
                  )
                }
              >
                {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy link'}
              </GhostButton>
            </div>
            <div className="-mr-1.5 ml-auto flex items-center gap-0.5 opacity-60 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
              <button
                type="button"
                onClick={onStartEdit}
                className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-transparent text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
                aria-label="Edit blueprint"
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                onClick={onStartDelete}
                className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md bg-transparent text-kumo-subtle transition-colors hover:bg-kumo-danger-tint hover:text-kumo-danger"
                aria-label="Delete blueprint"
              >
                <Trash size={13} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function GhostButton({
  onClick,
  icon,
  children,
}: {
  onClick: () => void | Promise<void>
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-transparent px-2 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
    >
      {icon}
      {children}
    </button>
  )
}

function AutosizingTextarea({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      autoFocus
      aria-label="Blueprint description"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          onCommit()
        }
        if (e.key === 'Escape') onCancel()
      }}
      rows={1}
      placeholder="Add a description"
      className="m-0 block w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive shadow-none outline-none focus:outline-none focus:ring-0"
    />
  )
}
