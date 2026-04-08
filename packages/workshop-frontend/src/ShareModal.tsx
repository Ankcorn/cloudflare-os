import { useState, useEffect, useCallback } from 'react'
import { Dialog, Button, Input, Tabs, Table, Badge, Checkbox, ClipboardText, Banner, useKumoToastManager } from '@cloudflare/kumo'
import { Copy, Trash, Plus, Link, ArrowsClockwise } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { Overseer, CollaboratorInfo, ShareKeyInfo, GadgetMetadata, AiChatAuthorInfo, BlueprintGadgetSummary } from '@gadgets/workshop-shared/api'

// Rows shown in the collaborator table: the owner (always first) plus actual collaborators.
type CollaboratorRow =
  | { kind: 'owner'; profile: AiChatAuthorInfo }
  | { kind: 'collaborator'; info: CollaboratorInfo }

function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSeconds < 60) return 'Just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

type Props = {
  open: boolean
  onClose: () => void
  overseer: RpcStub<Overseer>
  metadata: GadgetMetadata
  currentUser: AiChatAuthorInfo | null
}

export default function ShareModal({ open, onClose, overseer, metadata, currentUser }: Props) {
  const toasts = useKumoToastManager()

  const [collaborators, setCollaborators] = useState<CollaboratorInfo[]>([])
  const [shareKeys, setShareKeys] = useState<ShareKeyInfo[]>([])
  const [addUsername, setAddUsername] = useState('')
  const [addNote, setAddNote] = useState('')
  const [adding, setAdding] = useState(false)
  const [shareKeyNote, setShareKeyNote] = useState('')
  const [newShareLink, setNewShareLink] = useState<string | null>(null)
  const [creatingKey, setCreatingKey] = useState(false)
  const [tabKey, setTabKey] = useState('collaborators')

  // Blueprint state
  const [blueprints, setBlueprints] = useState<BlueprintGadgetSummary[]>([])
  const [blueprintsLoading, setBlueprintsLoading] = useState(false)
  const [newBpTitle, setNewBpTitle] = useState('')
  const [newBpDescription, setNewBpDescription] = useState('')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [creatingBp, setCreatingBp] = useState(false)
  const [editingBpTitle, setEditingBpTitle] = useState<string | null>(null)
  const [editingBpDesc, setEditingBpDesc] = useState<string | null>(null)
  const [editTitleValue, setEditTitleValue] = useState('')
  const [editDescValue, setEditDescValue] = useState('')

  // Confirm dialog state (replaces Modal.confirm and showDependentUsersDialog)
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string
    description?: string
    dependents?: CollaboratorInfo[]
    onConfirm: (keepUsers: string[]) => Promise<void>
  } | null>(null)
  const [confirmKeepSet, setConfirmKeepSet] = useState<Set<string>>(new Set())
  const [confirmLoading, setConfirmLoading] = useState(false)

  const isOwner = !metadata.owner

  const loadData = useCallback(async () => {
    try {
      const [collabs, keys] = await Promise.all([
        overseer.listCollaborators(),
        overseer.listShareKeys(),
      ])
      setCollaborators(collabs)
      setShareKeys(keys)
    } catch (err) {
      console.error('Failed to load share data:', err)
      toasts.add({ title: 'Failed to load sharing info', variant: 'error' })
    }
  }, [overseer])

  const loadBlueprints = useCallback(async () => {
    setBlueprintsLoading(true)
    try {
      const bps = await overseer.listBlueprints()
      setBlueprints(bps)
    } catch (err) {
      console.error('Failed to load blueprints:', err)
      toasts.add({ title: 'Failed to load blueprints', variant: 'error' })
    } finally {
      setBlueprintsLoading(false)
    }
  }, [overseer])

  useEffect(() => {
    if (open) {
      loadData()
      loadBlueprints()
      setNewShareLink(null)
    }
  }, [open, loadData, loadBlueprints])

  const handleAddCollaborator = async () => {
    if (!addUsername.trim()) return
    setAdding(true)
    try {
      const result = await overseer.addCollaborator(
        addUsername.trim(),
        addNote.trim() || undefined
      )
      if (result === null) {
        toasts.add({ title: 'No account found for that username.', variant: 'error' })
      } else {
        toasts.add({ title: `Added ${result.profile.name} as a collaborator.`, variant: 'success' })
        setAddUsername('')
        setAddNote('')
        await loadData()
      }
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to add collaborator.', variant: 'error' })
    } finally {
      setAdding(false)
    }
  }

  const openConfirmDialog = (opts: {
    title: string
    description?: string
    dependents?: CollaboratorInfo[]
    onConfirm: (keepUsers: string[]) => Promise<void>
  }) => {
    setConfirmKeepSet(new Set())
    setConfirmDialog(opts)
  }

  const handleConfirmDialogOk = async () => {
    if (!confirmDialog) return
    setConfirmLoading(true)
    try {
      await confirmDialog.onConfirm([...confirmKeepSet])
      setConfirmDialog(null)
    } catch (err: any) {
      toasts.add({ title: err.message || 'Operation failed.', variant: 'error' })
    } finally {
      setConfirmLoading(false)
    }
  }

  const handleRemoveCollaborator = async (profileId: string) => {
    try {
      const dependents = await overseer.previewRemoveCollaborator(profileId)

      if (dependents.length === 0) {
        openConfirmDialog({
          title: 'Remove Collaborator',
          description: 'Are you sure you want to remove this collaborator?',
          onConfirm: async () => {
            const removed = await overseer.removeCollaborator(profileId, [])
            toasts.add({
              title: removed.length > 0
                ? 'Collaborator removed.'
                : 'Your sharing link with this collaborator was removed.',
              variant: 'success',
            })
            await loadData()
          },
        })
      } else {
        openConfirmDialog({
          title: 'Remove Collaborator',
          description: 'This user shared with other users who will be removed as well, unless you choose to keep them.',
          dependents,
          onConfirm: async (keepUsers) => {
            await overseer.removeCollaborator(profileId, keepUsers)
            toasts.add({ title: 'Collaborator removed.', variant: 'success' })
            await loadData()
          },
        })
      }
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to remove collaborator.', variant: 'error' })
    }
  }

  const handleCreateShareKey = async () => {
    setCreatingKey(true)
    try {
      const { key } = await overseer.createShareKey(shareKeyNote.trim() || undefined)
      const url = `${window.location.origin}/gadget/${metadata.id}#share=${key}`
      setNewShareLink(url)
      setShareKeyNote('')
      await loadData()
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to create share link.', variant: 'error' })
    } finally {
      setCreatingKey(false)
    }
  }

  const handleRevokeShareKey = async (keyId: string) => {
    try {
      const dependents = await overseer.previewRevokeShareKey(keyId)

      if (dependents.length === 0) {
        openConfirmDialog({
          title: 'Revoke Share Link',
          description: 'This will prevent anyone from using this link to gain access.',
          onConfirm: async () => {
            await overseer.revokeShareKey(keyId, [])
            toasts.add({ title: 'Share link revoked.', variant: 'success' })
            await loadData()
          },
        })
      } else {
        openConfirmDialog({
          title: 'Revoke Share Link',
          description: 'Revoking this share link will also remove the following users who gained access through it, unless you choose to keep them.',
          dependents,
          onConfirm: async (keepUsers) => {
            await overseer.revokeShareKey(keyId, keepUsers)
            toasts.add({ title: 'Share link revoked.', variant: 'success' })
            await loadData()
          },
        })
      }
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to revoke share link.', variant: 'error' })
    }
  }

  const describeEdge = (info: CollaboratorInfo): string => {
    const parts: string[] = []
    for (const edge of info.addedBy) {
      if (edge.type === 'user') {
        parts.push(`Added by ${edge.sharer}`)
      } else {
        parts.push('Via share link')
      }
    }
    return parts.join(', ') || 'Unknown'
  }

  // The owner profile: if the current user IS the owner, use their own profile;
  // otherwise use the owner info from metadata.
  const ownerProfile: AiChatAuthorInfo | null = isOwner ? currentUser : (metadata.owner ?? null)

  // Build combined rows: owner first, then collaborators.
  const collaboratorRows: CollaboratorRow[] = [
    ...(ownerProfile ? [{ kind: 'owner' as const, profile: ownerProfile }] : []),
    ...collaborators.map(info => ({ kind: 'collaborator' as const, info })),
  ]

  return (
    <>
      <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
        <Dialog className="p-6 !w-[560px] !top-[15%] !-translate-y-0" size="lg">
          <Dialog.Title className="text-lg font-semibold mb-4">Share</Dialog.Title>

          <Tabs
            variant="segmented"
            tabs={[
              { value: 'collaborators', label: 'Collaborators' },
              { value: 'blueprints', label: 'Blueprints' },
            ]}
            value={tabKey}
            onValueChange={setTabKey}
          />

          <div className="mt-4">
            {/* ── Collaborators tab ─────────────────────────────────────── */}
            {tabKey === 'collaborators' && (
              <div className="space-y-4">
                {/* Add collaborator */}
                <div>
                  <p className="text-base font-semibold text-kumo-default mb-2">Add collaborator</p>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Username or email"
                      value={addUsername}
                      onChange={(e) => setAddUsername(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddCollaborator() }}
                      className="flex-1"
                    />
                    <Button
                      variant="primary"
                      onClick={handleAddCollaborator}
                      loading={adding}
                      disabled={!addUsername.trim()}
                    >
                      <Plus size={16} weight="bold" />
                      Add
                    </Button>
                  </div>
                </div>

                {/* Collaborator table */}
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>Name</Table.Head>
                      <Table.Head>Relationship</Table.Head>
                      <Table.Head className="w-16" />
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {collaboratorRows.map(row => {
                      const profile = row.kind === 'owner' ? row.profile : row.info.profile
                      const key = row.kind === 'owner' ? '__owner__' : row.info.profile.id
                      return (
                        <Table.Row key={key}>
                          <Table.Cell>
                            <div>
                              <span className="text-sm font-medium text-kumo-default">{profile.name}</span>
                              <br />
                              <span className="text-xs text-kumo-subtle">{profile.id}</span>
                            </div>
                          </Table.Cell>
                          <Table.Cell>
                            <span className="text-sm text-kumo-subtle">
                              {row.kind === 'owner' ? 'Owner' : describeEdge(row.info)}
                            </span>
                          </Table.Cell>
                          <Table.Cell>
                            {row.kind === 'collaborator' && (
                              <Button
                                variant="ghost"
                                size="xs"
                                onClick={() => handleRemoveCollaborator(row.info.profile.id)}
                                aria-label="Remove"
                              >
                                <Trash size={16} className="text-kumo-danger" />
                              </Button>
                            )}
                          </Table.Cell>
                        </Table.Row>
                      )
                    })}
                    {collaboratorRows.length === 0 && (
                      <Table.Row>
                        <Table.Cell colSpan={3}>
                          <span className="text-sm text-kumo-subtle">No collaborators.</span>
                        </Table.Cell>
                      </Table.Row>
                    )}
                  </Table.Body>
                </Table>

                {/* Share links */}
                <div>
                  <p className="text-base font-semibold text-kumo-default mb-2">Share links</p>
                  <div className="flex gap-2 mb-3">
                    <Input
                      placeholder="Note (optional)"
                      value={shareKeyNote}
                      onChange={(e) => setShareKeyNote(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleCreateShareKey() }}
                      className="flex-1"
                    />
                    <Button
                      variant="secondary"
                      onClick={handleCreateShareKey}
                      loading={creatingKey}
                    >
                      <Link size={16} />
                      Create link
                    </Button>
                  </div>

                  {newShareLink && (
                    <Banner
                      title="Share link created"
                      description={
                        <div className="space-y-2 mt-1">
                          <p className="text-xs text-kumo-subtle">This link won't be shown again.</p>
                          <ClipboardText
                            text={newShareLink}
                            size="sm"
                            tooltip={{ text: 'Copy link', copiedText: 'Copied!' }}
                          />
                        </div>
                      }
                      className="mb-3"
                    />
                  )}

                  <Table>
                    <Table.Header>
                      <Table.Row>
                        <Table.Head>Note</Table.Head>
                        <Table.Head>Created</Table.Head>
                        <Table.Head>Created by</Table.Head>
                        <Table.Head className="w-16" />
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {shareKeys.map(sk => (
                        <Table.Row key={sk.keyId}>
                          <Table.Cell>
                            <span className="text-sm text-kumo-default">{sk.note || '(no note)'}</span>
                          </Table.Cell>
                          <Table.Cell>
                            <span className="text-xs text-kumo-subtle">{formatRelativeTime(sk.created)}</span>
                          </Table.Cell>
                          <Table.Cell>
                            <span className="text-xs text-kumo-subtle">{sk.createdBy.name}</span>
                          </Table.Cell>
                          <Table.Cell>
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={() => handleRevokeShareKey(sk.keyId)}
                              aria-label="Revoke"
                            >
                              <Trash size={16} className="text-kumo-danger" />
                            </Button>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                      {shareKeys.length === 0 && (
                        <Table.Row>
                          <Table.Cell colSpan={4}>
                            <span className="text-sm text-kumo-subtle">No share links.</span>
                          </Table.Cell>
                        </Table.Row>
                      )}
                    </Table.Body>
                  </Table>
                </div>
              </div>
            )}

            {/* ── Blueprints tab ───────────────────────────────────────── */}
            {tabKey === 'blueprints' && (
              <div className="space-y-2">
                {blueprints.map(bp => (
                  <div key={bp.id} className="rounded-lg border border-kumo-line bg-kumo-elevated p-3">
                    <div className="flex items-center gap-2 mb-1">
                      {editingBpTitle === bp.id ? (
                        <div className="flex flex-1 gap-1">
                          <Input
                            value={editTitleValue}
                            onChange={(e) => setEditTitleValue(e.target.value)}
                            onKeyDown={async (e) => {
                              if (e.key === 'Enter') {
                                await overseer.updateBlueprint(bp.id, { title: editTitleValue })
                                setEditingBpTitle(null)
                                loadBlueprints()
                              }
                            }}
                            className="flex-1"
                          />
                          <Button size="xs" variant="primary" onClick={async () => {
                            await overseer.updateBlueprint(bp.id, { title: editTitleValue })
                            setEditingBpTitle(null)
                            loadBlueprints()
                          }}>Save</Button>
                          <Button size="xs" variant="secondary" onClick={() => setEditingBpTitle(null)}>Cancel</Button>
                        </div>
                      ) : (
                        <span
                          className="text-sm font-medium text-kumo-default cursor-pointer flex-1"
                          onClick={() => {
                            setEditingBpTitle(bp.id)
                            setEditTitleValue(bp.title)
                          }}
                        >
                          {bp.title}
                        </span>
                      )}
                      {bp.dirty && (
                        <Badge variant="destructive">
                          Publish failed
                        </Badge>
                      )}
                    </div>

                    {editingBpDesc === bp.id ? (
                      <div className="mb-2">
                        <textarea
                          value={editDescValue}
                          onChange={(e) => setEditDescValue(e.target.value)}
                          rows={2}
                          className="w-full rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-2 focus:ring-kumo-brand/40"
                        />
                        <div className="flex gap-1 mt-1">
                          <Button size="xs" variant="primary" onClick={async () => {
                            await overseer.updateBlueprint(bp.id, { description: editDescValue })
                            setEditingBpDesc(null)
                            loadBlueprints()
                          }}>Save</Button>
                          <Button size="xs" variant="secondary" onClick={() => setEditingBpDesc(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <p
                        className="text-xs text-kumo-subtle cursor-pointer mb-1"
                        onClick={() => {
                          setEditingBpDesc(bp.id)
                          setEditDescValue(bp.description)
                        }}
                      >
                        {bp.description || '(click to add description)'}
                      </p>
                    )}

                    <p className="text-xs text-kumo-subtle">
                      v{bp.version} - Code from {new Date(bp.codeVersionDate).toLocaleDateString()}
                    </p>

                    <div className="flex gap-1 mt-2">
                      <Button size="xs" variant="secondary" onClick={async () => {
                        try {
                          await overseer.updateBlueprint(bp.id, { updateCode: true })
                          toasts.add({ title: 'Blueprint updated to current code.', variant: 'success' })
                          loadBlueprints()
                        } catch (err: any) {
                          toasts.add({ title: err.message || 'Failed to update blueprint.', variant: 'error' })
                        }
                      }}>
                        <ArrowsClockwise size={14} />
                        Update code
                      </Button>
                      <Button size="xs" variant="secondary" onClick={() => {
                        const url = `${window.location.origin}/blueprint/${bp.id}`
                        navigator.clipboard.writeText(url)
                        toasts.add({ title: 'Blueprint link copied.', variant: 'success' })
                      }}>
                        <Copy size={14} />
                        Copy link
                      </Button>
                      {bp.dirty && (
                        <Button size="xs" variant="secondary" onClick={async () => {
                          try {
                            await overseer.retryBlueprintPublish(bp.id)
                            toasts.add({ title: 'Blueprint published successfully.', variant: 'success' })
                            loadBlueprints()
                          } catch (err: any) {
                            toasts.add({ title: err.message || 'Retry failed.', variant: 'error' })
                          }
                        }}>
                          Retry publish
                        </Button>
                      )}
                      <Button size="xs" variant="ghost" onClick={() => {
                        openConfirmDialog({
                          title: 'Delete Blueprint',
                          description: 'Delete this blueprint? This cannot be undone.',
                          onConfirm: async () => {
                            await overseer.deleteBlueprint(bp.id)
                            toasts.add({ title: 'Blueprint deleted.', variant: 'success' })
                            loadBlueprints()
                          },
                        })
                      }}>
                        <Trash size={14} className="text-kumo-danger" />
                        <span className="text-kumo-danger">Delete</span>
                      </Button>
                    </div>
                  </div>
                ))}

                {blueprints.length === 0 && !blueprintsLoading && (
                  <div className="text-center py-4">
                    <p className="text-sm text-kumo-subtle">No blueprints yet.</p>
                  </div>
                )}

                {/* Create new blueprint */}
                {showCreateForm ? (
                  <div className="rounded-lg border border-kumo-line bg-kumo-elevated p-3 space-y-2">
                    <p className="text-sm font-semibold text-kumo-default">New Blueprint</p>
                    <Input
                      placeholder="Title"
                      value={newBpTitle}
                      onChange={(e) => setNewBpTitle(e.target.value)}
                    />
                    <textarea
                      placeholder="Description (optional)"
                      value={newBpDescription}
                      onChange={(e) => setNewBpDescription(e.target.value)}
                      rows={2}
                      className="w-full rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-2 focus:ring-kumo-brand/40"
                    />
                    <div className="flex gap-2">
                      <Button
                        variant="primary"
                        size="xs"
                        loading={creatingBp}
                        onClick={async () => {
                          setCreatingBp(true)
                          try {
                            await overseer.createBlueprint(
                              newBpTitle.trim() || undefined,
                              newBpDescription.trim() || undefined,
                            )
                            toasts.add({ title: 'Blueprint created.', variant: 'success' })
                            setShowCreateForm(false)
                            setNewBpTitle('')
                            setNewBpDescription('')
                            loadBlueprints()
                          } catch (err: any) {
                            toasts.add({ title: err.message || 'Failed to create blueprint.', variant: 'error' })
                          } finally {
                            setCreatingBp(false)
                          }
                        }}
                      >
                        Create
                      </Button>
                      <Button variant="secondary" size="xs" onClick={() => {
                        setShowCreateForm(false)
                        setNewBpTitle('')
                        setNewBpDescription('')
                      }}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      setNewBpTitle(metadata.title)
                      setShowCreateForm(true)
                    }}
                  >
                    <Plus size={16} />
                    Create Blueprint
                  </Button>
                )}
              </div>
            )}
          </div>
        </Dialog>
      </Dialog.Root>

      {/* ── Confirmation dialog (replaces Modal.confirm / dependent users dialog) ── */}
      <Dialog.Root
        role="alertdialog"
        open={confirmDialog !== null}
        onOpenChange={(o) => { if (!o) setConfirmDialog(null) }}
      >
        <Dialog className="p-6" size="sm">
          <Dialog.Title className="text-lg font-semibold">{confirmDialog?.title}</Dialog.Title>
          {confirmDialog?.description && (
            <Dialog.Description className="mt-2 text-sm text-kumo-subtle">
              {confirmDialog.description}
            </Dialog.Description>
          )}

          {/* Dependent users checkboxes */}
          {confirmDialog?.dependents && confirmDialog.dependents.length > 0 && (
            <div className="mt-3 space-y-2">
              <p className="text-sm font-medium text-kumo-default">Keep?</p>
              {confirmDialog.dependents.map(dep => (
                <Checkbox
                  key={dep.profile.id}
                  label={`${dep.profile.name} (${dep.profile.id})`}
                  checked={confirmKeepSet.has(dep.profile.id)}
                  onCheckedChange={(checked) => {
                    setConfirmKeepSet(prev => {
                      const next = new Set(prev)
                      if (checked) {
                        next.add(dep.profile.id)
                      } else {
                        next.delete(dep.profile.id)
                      }
                      return next
                    })
                  }}
                />
              ))}
            </div>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close render={(props) => (
              <Button variant="secondary" {...props} disabled={confirmLoading}>Cancel</Button>
            )} />
            <Button
              variant="destructive"
              onClick={handleConfirmDialogOk}
              loading={confirmLoading}
            >
              Confirm
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  )
}
