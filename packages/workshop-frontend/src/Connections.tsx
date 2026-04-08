import { useState, useEffect } from 'react'
import { Button, Table, Switch, Popover, Dialog, useKumoToastManager } from '@cloudflare/kumo'
import {
  Plus,
  Pencil,
  Check,
  X,
  Trash,
  ShareNetwork,
  CaretRight,
} from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { Overseer, GatekeeperMetadata, ActionLogEntry, AuthenticatedApi, BlueprintBindingAnnotation } from '@gadgets/workshop-shared/api'
import NewGatekeeperModal from './NewGatekeeperModal'


interface ConnectionsProps {
  overseer: RpcStub<Overseer>
  authenticatedApi: RpcStub<AuthenticatedApi>
  onConnectionsChange?: () => void
  isVisible?: boolean
  onHasGatekeepersChange?: (hasGatekeepers: boolean) => void
}

export default function Connections({ overseer, authenticatedApi: _authenticatedApi, onConnectionsChange, isVisible, onHasGatekeepersChange }: ConnectionsProps) {
  const [gatekeepers, setGatekeepers] = useState<GatekeeperMetadata[]>([])
  const [actions, setActions] = useState<ActionLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [actionsLoading, setActionsLoading] = useState(true)
  const [editingGatekeeper, setEditingGatekeeper] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [isNewConnectionModalVisible, setIsNewConnectionModalVisible] = useState(false)
  const [processingActions, setProcessingActions] = useState<Set<number>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<{ bindingName: string; resourceTitle: string } | null>(null)
  const [expandedActions, setExpandedActions] = useState<Set<number>>(new Set())
  const toasts = useKumoToastManager()

  const loadGatekeepers = async () => {
    try {
      const gatekeeperList = await overseer.listGatekeepers()
      setGatekeepers(gatekeeperList)
      onHasGatekeepersChange?.(gatekeeperList.length > 0)
    } catch (err) {
      console.error('Failed to load gatekeepers:', err)
      toasts.add({ title: 'Failed to load connections', variant: 'error' })
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
      toasts.add({ title: 'Failed to load actions', variant: 'error' })
    } finally {
      setActionsLoading(false)
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

  const handleEditStart = (bindingName: string) => {
    setEditingGatekeeper(bindingName)
    setEditValue(bindingName)
  }

  const handleEditSave = async (bindingName: string) => {
    if (!editValue.trim()) {
      toasts.add({ title: 'Binding name cannot be empty', variant: 'error' })
      return
    }

    try {
      using gatekeeper = await overseer.getGatekeeper(bindingName)
      if (gatekeeper) {
        await gatekeeper.setBindingName(editValue.trim())
        await loadGatekeepers()
        onConnectionsChange?.()
      }
    } catch (err) {
      console.error('Failed to rename gatekeeper:', err)
      toasts.add({ title: 'Failed to update binding name', variant: 'error' })
    } finally {
      setEditingGatekeeper(null)
    }
  }

  const handleEditCancel = () => {
    setEditingGatekeeper(null)
    setEditValue('')
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    try {
      using gatekeeper = await overseer.getGatekeeper(deleteTarget.bindingName)
      if (gatekeeper) {
        await gatekeeper.remove()
        await loadGatekeepers()
        onConnectionsChange?.()
      }
    } catch (err) {
      console.error('Failed to delete gatekeeper:', err)
      toasts.add({ title: 'Failed to delete connection', variant: 'error' })
    } finally {
      setDeleteTarget(null)
    }
  }

  const handleApproveAction = async (actionId: number) => {
    setProcessingActions(prev => new Set(prev).add(actionId))
    try {
      await overseer.approveAction(actionId)
      await loadActions()
    } catch (err) {
      console.error('Failed to approve action:', err)
      toasts.add({ title: 'Failed to approve action', variant: 'error' })
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
      toasts.add({ title: 'Failed to reject action', variant: 'error' })
    } finally {
      setProcessingActions(prev => {
        const newSet = new Set(prev)
        newSet.delete(actionId)
        return newSet
      })
    }
  }

  const toggleExpanded = (id: number) => {
    setExpandedActions(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const formatDate = (date: Date) => {
    return new Date(date).toLocaleString()
  }

  const sortedActions = [...actions].sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )

  return (
    <div className="p-6 h-[calc(100vh-64px-46px)] overflow-auto bg-kumo-elevated">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-kumo-default m-0">
          Connections
        </h2>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setIsNewConnectionModalVisible(true)}
        >
          <Plus size={14} className="mr-1" />
          New Connection
        </Button>
      </div>

      {/* Gatekeepers table */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-sm text-kumo-subtle">
          Loading connections...
        </div>
      ) : gatekeepers.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-sm text-kumo-subtle">No connections yet.</p>
          <p className="text-xs text-kumo-inactive mt-1">
            Click "New Connection" to connect to external resources.
          </p>
        </div>
      ) : (
        <Table layout="fixed">
          <Table.Header>
            <Table.Row>
              <Table.Head>Binding Name</Table.Head>
              <Table.Head>Resource Title</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {gatekeepers.map((gk) => (
              <Table.Row key={gk.bindingName}>
                <Table.Cell>
                  {editingGatekeeper === gk.bindingName ? (
                    <div className="flex items-center gap-1">
                      <input
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleEditSave(gk.bindingName) }}
                        placeholder="Enter binding name"
                        autoFocus
                        className="flex-1 px-2 py-1 text-sm rounded border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:border-kumo-brand"
                      />
                      <Button
                        variant="primary"
                        size="xs"
                        onClick={() => handleEditSave(gk.bindingName)}
                        disabled={!editValue.trim()}
                      >
                        <Check size={12} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={handleEditCancel}
                      >
                        <X size={12} />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm text-kumo-default bg-kumo-tint px-1.5 py-0.5 rounded">
                        {gk.bindingName}
                      </span>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => handleEditStart(gk.bindingName)}
                      >
                        <Pencil size={12} />
                      </Button>
                      <BlueprintAnnotationPopover
                        overseer={overseer}
                        bindingName={gk.bindingName}
                        resourceTitle={gk.resourceTitle}
                        toasts={toasts}
                      />
                      <Button
                        variant="ghost"
                        size="xs"
                        className="text-kumo-danger hover:text-kumo-danger"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleteTarget({ bindingName: gk.bindingName, resourceTitle: gk.resourceTitle })
                        }}
                      >
                        <Trash size={12} />
                      </Button>
                    </div>
                  )}
                </Table.Cell>
                <Table.Cell>
                  <span className="text-sm font-semibold text-kumo-default">
                    {gk.resourceTitle}
                  </span>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}

      {/* Action Log */}
      <div className="mt-8 mb-4">
        <h3 className="text-base font-semibold text-kumo-default m-0">
          Action Log ({actions.length})
        </h3>
      </div>

      {actionsLoading ? (
        <div className="flex items-center justify-center py-12 text-sm text-kumo-subtle">
          Loading actions...
        </div>
      ) : sortedActions.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-sm text-kumo-subtle">No actions yet.</p>
          <p className="text-xs text-kumo-inactive mt-1">
            Actions will appear here as the gadget interacts with external resources.
          </p>
        </div>
      ) : (
        <Table layout="fixed">
          <Table.Header>
            <Table.Row>
              <Table.Head style={{ width: '3%' }}>{/* expand */}</Table.Head>
              <Table.Head style={{ width: '15%' }}>Resource</Table.Head>
              <Table.Head style={{ width: '15%' }}>Created</Table.Head>
              <Table.Head style={{ width: '42%' }}>Action</Table.Head>
              <Table.Head style={{ width: '25%' }}>Status</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {sortedActions.map((record) => {
              const isProcessing = processingActions.has(record.id)
              const isExpanded = expandedActions.has(record.id)

              return (
                <ActionRow
                  key={record.id}
                  record={record}
                  isProcessing={isProcessing}
                  isExpanded={isExpanded}
                  onToggleExpand={() => toggleExpanded(record.id)}
                  onApprove={() => handleApproveAction(record.id)}
                  onReject={() => handleRejectAction(record.id)}
                  formatDate={formatDate}
                />
              )
            })}
          </Table.Body>
        </Table>
      )}

      {/* Delete confirmation dialog */}
      <Dialog.Root open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <Dialog className="p-6" size="sm">
          <Dialog.Title className="text-lg font-semibold mb-2">
            Delete Connection
          </Dialog.Title>
          <p className="text-sm text-kumo-subtle mb-6">
            Are you sure you want to delete the connection "{deleteTarget?.resourceTitle}" ({deleteTarget?.bindingName})? This action cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteConfirm}>
              Delete
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>

      <NewGatekeeperModal
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
    </div>
  )
}

// ── Action row with expandable detail ────────────────────────────────────────

function ActionRow({
  record,
  isProcessing,
  isExpanded,
  onToggleExpand,
  onApprove,
  onReject,
  formatDate,
}: {
  record: ActionLogEntry
  isProcessing: boolean
  isExpanded: boolean
  onToggleExpand: () => void
  onApprove: () => void
  onReject: () => void
  formatDate: (date: Date) => string
}) {
  return (
    <>
      <Table.Row>
        <Table.Cell>
          <button
            onClick={onToggleExpand}
            className="p-0.5 rounded hover:bg-kumo-tint transition-colors"
          >
            <CaretRight
              size={14}
              className={`text-kumo-subtle transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            />
          </button>
        </Table.Cell>
        <Table.Cell>
          <span className="text-sm">
            {record.bindingName && (
              <span className="font-mono text-xs text-kumo-default bg-kumo-tint px-1 py-0.5 rounded mr-1">
                {record.bindingName}
              </span>
            )}
            {record.resourceUrl ? (
              <a
                href={record.resourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-kumo-brand hover:underline"
              >
                {record.resourceTitle}
              </a>
            ) : (
              <span className="text-kumo-default">{record.resourceTitle}</span>
            )}
          </span>
        </Table.Cell>
        <Table.Cell>
          <span className="text-xs text-kumo-subtle">{formatDate(record.createdAt)}</span>
        </Table.Cell>
        <Table.Cell>
          <span className="text-sm text-kumo-default">{record.description.title}</span>
        </Table.Cell>
        <Table.Cell>
          {record.state === 'pending' ? (
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                size="xs"
                onClick={onApprove}
                loading={isProcessing}
                disabled={isProcessing}
              >
                Approve
              </Button>
              <Button
                variant="destructive"
                size="xs"
                onClick={onReject}
                loading={isProcessing}
                disabled={isProcessing}
              >
                Reject
              </Button>
            </div>
          ) : record.state === 'approved' ? (
            <span className="text-xs text-kumo-subtle">
              Approved {record.appliedAt ? formatDate(record.appliedAt) : ''}
            </span>
          ) : record.state === 'rejected' ? (
            <span className="text-xs text-kumo-subtle">Rejected</span>
          ) : null}
        </Table.Cell>
      </Table.Row>
      {isExpanded && (
        <Table.Row>
          <Table.Cell />
          <Table.Cell colSpan={4}>
            <div className="py-3 px-4 bg-kumo-tint rounded">
              <p className="text-xs font-semibold text-kumo-default mb-1">Description:</p>
              <p className="text-sm text-kumo-subtle whitespace-pre-wrap m-0">
                {record.description.description}
              </p>
            </div>
          </Table.Cell>
        </Table.Row>
      )}
    </>
  )
}

// ── Blueprint annotation popover ─────────────────────────────────────────────

function BlueprintAnnotationPopover({
  overseer,
  bindingName,
  resourceTitle,
  toasts,
}: {
  overseer: RpcStub<Overseer>
  bindingName: string
  resourceTitle: string
  toasts: ReturnType<typeof useKumoToastManager>
}) {
  const [annotation, setAnnotation] = useState<BlueprintBindingAnnotation>({
    included: true,
    title: resourceTitle,
    description: '',
    suggestValue: false,
  })
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  const loadAnnotation = async () => {
    if (loaded) return
    try {
      using gk = await overseer.getGatekeeper(bindingName)
      if (gk) {
        const existing = await gk.getBlueprintAnnotation()
        if (existing) {
          setAnnotation(existing)
        } else {
          setAnnotation({ included: true, title: resourceTitle, description: '', suggestValue: false })
        }
        setLoaded(true)
      }
    } catch (err) {
      console.error('Failed to load annotation:', err)
      toasts.add({ title: 'Failed to load annotation', variant: 'error' })
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      using gk = await overseer.getGatekeeper(bindingName)
      if (gk) {
        await gk.setBlueprintAnnotation(annotation)
        toasts.add({ title: 'Blueprint annotation saved', variant: 'success' })
      }
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to save annotation', variant: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Popover onOpenChange={(open: boolean) => { if (open) loadAnnotation() }}>
      <Popover.Trigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-label="Blueprint annotation"
        >
          <ShareNetwork size={12} />
        </Button>
      </Popover.Trigger>
      <Popover.Content side="bottom" align="start" className="w-72">
        <p className="text-sm font-semibold text-kumo-default mb-3">Blueprint annotation</p>
        <div className="space-y-3">
          <Switch
            label="Include in blueprints"
            size="sm"
            checked={annotation.included}
            onCheckedChange={(checked) =>
              setAnnotation(prev => ({ ...prev, included: checked }))
            }
          />
          {annotation.included && (
            <>
              <div>
                <label className="block text-xs font-medium text-kumo-subtle mb-1">Title</label>
                <input
                  value={annotation.title}
                  onChange={(e) => setAnnotation(prev => ({ ...prev, title: e.target.value }))}
                  placeholder="Display name for this binding"
                  className="w-full px-2 py-1.5 text-sm rounded border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:border-kumo-brand"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-kumo-subtle mb-1">Description</label>
                <textarea
                  value={annotation.description}
                  onChange={(e) => setAnnotation(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Explain what kind of resource to connect"
                  rows={2}
                  className="w-full px-2 py-1.5 text-sm rounded border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:border-kumo-brand resize-none"
                />
              </div>
              <Switch
                label="Suggest specific resource"
                size="sm"
                checked={annotation.suggestValue ?? false}
                onCheckedChange={(checked) =>
                  setAnnotation(prev => ({ ...prev, suggestValue: checked }))
                }
              />
            </>
          )}
          <Button
            variant="primary"
            size="sm"
            className="w-full"
            onClick={handleSave}
            loading={saving}
          >
            Save
          </Button>
        </div>
      </Popover.Content>
    </Popover>
  )
}
