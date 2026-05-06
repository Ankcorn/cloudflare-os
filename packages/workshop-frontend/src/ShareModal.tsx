import { useState, useEffect, useCallback, useRef } from 'react'
import { Checkbox, Dialog, useKumoToastManager } from '@cloudflare/kumo'
import { Check, Copy, Link, Trash, X } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { Overseer, CollaboratorInfo, ShareKeyInfo, GadgetMetadata, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from './components/WorkshopControls'
import { TabButton } from './components/TabButton'
import { copyToClipboard } from './clipboard'

type CollaboratorRow =
  | { kind: 'owner'; profile: AiChatAuthorInfo }
  | { kind: 'collaborator'; info: CollaboratorInfo }

type Props = {
  open: boolean
  onClose: () => void
  overseer: RpcStub<Overseer>
  metadata: GadgetMetadata
  currentUser: AiChatAuthorInfo | null
}

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

function initials(name: string) {
  return name.split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase()
}

function DependentKeepList({
  dependents,
  keepSet,
  onKeepSetChange,
}: {
  dependents: CollaboratorInfo[]
  keepSet: Set<string>
  onKeepSetChange: (next: Set<string>) => void
}) {
  if (dependents.length === 0) return null

  return (
    <div className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2">
      <p className="mb-2 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-default">
        Keep access for:
      </p>
      <div className="space-y-2">
        {dependents.map(dep => (
          <Checkbox
            key={dep.profile.id}
            label={`${dep.profile.name} (${dep.profile.id})`}
            checked={keepSet.has(dep.profile.id)}
            onCheckedChange={(checked) => {
              const next = new Set(keepSet)
              if (checked) {
                next.add(dep.profile.id)
              } else {
                next.delete(dep.profile.id)
              }
              onKeepSetChange(next)
            }}
          />
        ))}
      </div>
    </div>
  )
}

export default function ShareModal({ open, onClose, overseer, metadata, currentUser }: Props) {
  const toasts = useKumoToastManager()

  const [collaborators, setCollaborators] = useState<CollaboratorInfo[]>([])
  const [shareKeys, setShareKeys] = useState<ShareKeyInfo[]>([])
  const [addUsername, setAddUsername] = useState('')
  const [adding, setAdding] = useState(false)
  const [newShareLink, setNewShareLink] = useState<string | null>(null)
  const [newShareLinkCopied, setNewShareLinkCopied] = useState<boolean | null>(null)
  const [creatingKey, setCreatingKey] = useState(false)
  const [tabKey, setTabKey] = useState<'people' | 'links'>('people')
  const [editingShareKeyId, setEditingShareKeyId] = useState<string | null>(null)
  const [editingShareKeyNote, setEditingShareKeyNote] = useState('')
  const [savingShareKeyNote, setSavingShareKeyNote] = useState(false)
  const [revokeTarget, setRevokeTarget] = useState<{
    keyId: string
    dependents: CollaboratorInfo[]
  } | null>(null)
  const [revokeLoadingKeyId, setRevokeLoadingKeyId] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<{
    profileId: string
    dependents: CollaboratorInfo[]
  } | null>(null)
  const [removeLoadingProfileId, setRemoveLoadingProfileId] = useState<string | null>(null)
  const [removeKeepSet, setRemoveKeepSet] = useState<Set<string>>(new Set())
  const [revokeKeepSet, setRevokeKeepSet] = useState<Set<string>>(new Set())
  const wasOpenRef = useRef(false)

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

  useEffect(() => {
    if (open) {
      if (!wasOpenRef.current) setTabKey('people')
      loadData()
      setNewShareLink(null)
      setNewShareLinkCopied(null)
    }
    wasOpenRef.current = open
  }, [open, loadData])

  const ownerProfile: AiChatAuthorInfo | null = isOwner ? currentUser : (metadata.owner ?? null)
  const collaboratorRows: CollaboratorRow[] = [
    ...(ownerProfile ? [{ kind: 'owner' as const, profile: ownerProfile }] : []),
    ...collaborators.map(info => ({ kind: 'collaborator' as const, info })),
  ]

  const describeEdge = (info: CollaboratorInfo): string => {
    const parts: string[] = []
    for (const edge of info.addedBy) {
      parts.push(edge.type === 'user' ? `Added by ${edge.sharer}` : 'Via share link')
    }
    return parts.join(', ') || 'Collaborator'
  }

  const handleAddCollaborator = async () => {
    if (!addUsername.trim()) return
    setAdding(true)
    try {
      const result = await overseer.addCollaborator(addUsername.trim(), undefined)
      if (result === null) {
        toasts.add({ title: 'No account found for that username.', variant: 'error' })
      } else {
        toasts.add({ title: `Added ${result.profile.name} as a collaborator.`, variant: 'success' })
        setAddUsername('')
        await loadData()
      }
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to add collaborator.', variant: 'error' })
    } finally {
      setAdding(false)
    }
  }

  const handleStartRemoveCollaborator = async (profileId: string) => {
    setRemoveLoadingProfileId(profileId)
    try {
      const dependents = await overseer.previewRemoveCollaborator(profileId)
      setRemoveTarget({ profileId, dependents })
      setRemoveKeepSet(new Set())
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to remove collaborator.', variant: 'error' })
    } finally {
      setRemoveLoadingProfileId(null)
    }
  }

  const handleConfirmRemoveCollaborator = async () => {
    if (!removeTarget) return
    setRemoveLoadingProfileId(removeTarget.profileId)
    try {
      const removed = await overseer.removeCollaborator(removeTarget.profileId, [...removeKeepSet])
      toasts.add({
        title: removed.length > 0
          ? 'Collaborator removed.'
          : 'Your sharing link with this collaborator was removed.',
        variant: 'success',
      })
      setRemoveTarget(null)
      setRemoveKeepSet(new Set())
      await loadData()
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to remove collaborator.', variant: 'error' })
    } finally {
      setRemoveLoadingProfileId(null)
    }
  }

  const handleCreateShareKey = async () => {
    setCreatingKey(true)
    try {
      const { key } = await overseer.createShareKey(undefined)
      const url = `${window.location.origin}/gadget/${metadata.id}#share=${key}`
      setNewShareLink(url)
      setNewShareLinkCopied(false)
      toasts.add({ title: 'Share link created.', variant: 'success' })
      await loadData()
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to create share link.', variant: 'error' })
    } finally {
      setCreatingKey(false)
    }
  }

  const handleStartRevokeShareKey = async (keyId: string) => {
    setRevokeLoadingKeyId(keyId)
    try {
      const dependents = await overseer.previewRevokeShareKey(keyId)
      setRevokeTarget({ keyId, dependents })
      setRevokeKeepSet(new Set())
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to revoke share link.', variant: 'error' })
    } finally {
      setRevokeLoadingKeyId(null)
    }
  }

  const handleConfirmRevokeShareKey = async () => {
    if (!revokeTarget) return
    setRevokeLoadingKeyId(revokeTarget.keyId)
    try {
      await overseer.revokeShareKey(revokeTarget.keyId, [...revokeKeepSet])
      toasts.add({ title: 'Share link revoked.', variant: 'success' })
      setRevokeTarget(null)
      setRevokeKeepSet(new Set())
      await loadData()
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to revoke share link.', variant: 'error' })
    } finally {
      setRevokeLoadingKeyId(null)
    }
  }

  const startEditingShareKeyNote = (shareKey: ShareKeyInfo) => {
    setEditingShareKeyId(shareKey.keyId)
    setEditingShareKeyNote(shareKey.note || '')
  }

  const cancelEditingShareKeyNote = () => {
    setEditingShareKeyId(null)
    setEditingShareKeyNote('')
  }

  const handleSaveShareKeyNote = async () => {
    if (!editingShareKeyId) return
    setSavingShareKeyNote(true)
    try {
      await overseer.updateShareKey(
        editingShareKeyId,
        editingShareKeyNote.trim() || undefined,
      )
      toasts.add({ title: 'Share link note updated.', variant: 'success' })
      cancelEditingShareKeyNote()
      await loadData()
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to update share link note.', variant: 'error' })
    } finally {
      setSavingShareKeyNote(false)
    }
  }

  return (
    <>
      <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
        <Dialog className="!z-[1000] !w-[min(640px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0 !top-[10%] !-translate-y-0" size="lg">
          <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-4 py-5 sm:px-6">
            <div>
              <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                Share gadget
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                Invite collaborators or create share links for this gadget.
              </Dialog.Description>
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

          <div className="px-4 pt-4 sm:px-6">
            <div className="flex items-center gap-5 border-b border-kumo-line">
              {[
                ['people', 'People'],
                ['links', 'Share links'],
              ].map(([value, label]) => {
                const selected = tabKey === value
                return (
                  <TabButton
                    key={value}
                    active={selected}
                    onClick={() => setTabKey(value as 'people' | 'links')}
                    className="h-10"
                  >
                    {label}
                  </TabButton>
                )
              })}
            </div>
          </div>

          <div className="px-4 py-5 sm:px-6">
            {tabKey === 'people' && (
              <div className="space-y-5">
                <div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <WorkshopInput
                      placeholder="Username or email"
                      aria-label="Username or email"
                      value={addUsername}
                      onChange={(e) => setAddUsername(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddCollaborator() }}
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      className="flex-1"
                    />
                    <WorkshopButton
                      tone="primary"
                      className="min-w-[64px]"
                      onClick={handleAddCollaborator}
                      disabled={!addUsername.trim() || adding}
                    >
                      {adding ? 'Inviting...' : 'Invite'}
                    </WorkshopButton>
                  </div>
                </div>

                <section>
                  <h3 className="mb-2 text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                    People with access
                  </h3>
                  <div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
                    {collaboratorRows.map((row, index) => {
                      const profile = row.kind === 'owner' ? row.profile : row.info.profile
                      const key = row.kind === 'owner' ? '__owner__' : row.info.profile.id
                      const isRemoving = row.kind === 'collaborator' && removeTarget?.profileId === row.info.profile.id
                      return (
                        <div
                          key={key}
                          className={`px-3 py-3 ${index > 0 ? 'border-t border-kumo-line' : ''} ${
                            isRemoving ? 'bg-kumo-danger-tint/40' : ''
                          }`}
                        >
                          {isRemoving && row.kind === 'collaborator' ? (
                            <div className="space-y-3">
                            <div className="flex flex-wrap items-center gap-3">
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-danger">
                                  Remove {profile.name}?
                                </p>
                                <p className="truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                                  {removeTarget.dependents.length > 0
                                    ? `${removeTarget.dependents.length} user${removeTarget.dependents.length === 1 ? '' : 's'} may lose access.`
                                    : 'They will no longer have access to this gadget.'}
                                </p>
                              </div>
                              <WorkshopButton
                                tone="danger"
                                className="min-w-[68px]"
                                onClick={handleConfirmRemoveCollaborator}
                                disabled={removeLoadingProfileId === profile.id}
                              >
                                {removeLoadingProfileId === profile.id ? 'Removing...' : 'Remove'}
                              </WorkshopButton>
                              <WorkshopButton
                                className="min-w-[64px]"
                                onClick={() => {
                                  setRemoveTarget(null)
                                  setRemoveKeepSet(new Set())
                                }}
                                disabled={removeLoadingProfileId === profile.id}
                              >
                                Cancel
                              </WorkshopButton>
                            </div>
                            <DependentKeepList
                              dependents={removeTarget.dependents}
                              keepSet={removeKeepSet}
                              onKeepSetChange={setRemoveKeepSet}
                            />
                            </div>
                          ) : (
                          <div className="flex flex-wrap items-center gap-3">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-kumo-tint text-[11px] font-medium text-kumo-strong">
                            {initials(profile.name)}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                              {profile.name}
                            </p>
                            <p className="truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                              {profile.id}
                            </p>
                          </div>
                          <div className="ml-auto flex shrink-0 items-center gap-2">
                            <span className="text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                              {row.kind === 'owner' ? 'Owner' : describeEdge(row.info)}
                            </span>
                            {row.kind === 'collaborator' && (
                              <WorkshopIconButton
                                danger
                                className="!h-7 !w-7"
                                onClick={() => handleStartRemoveCollaborator(row.info.profile.id)}
                                aria-label="Remove collaborator"
                                disabled={removeLoadingProfileId === row.info.profile.id}
                              >
                                <Trash size={14} />
                              </WorkshopIconButton>
                            )}
                          </div>
                          </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </section>
              </div>
            )}

            {tabKey === 'links' && (
              <div className="space-y-4">
                  <button
                    type="button"
                    onClick={handleCreateShareKey}
                    disabled={creatingKey}
                    className="flex w-full items-center justify-between rounded-xl border border-kumo-line bg-kumo-base px-4 py-3 text-left transition-colors hover:bg-kumo-elevated"
                  >
                    <span>
                      <span className="block text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                        {creatingKey ? 'Creating share link...' : 'Create share link'}
                      </span>
                      <span className="mt-0.5 block text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                        Creates a reusable invite link.
                      </span>
                    </span>
                    <Link size={16} className="mr-1 text-kumo-subtle" />
                  </button>

                  {newShareLink && (
                  <div className="rounded-xl border border-kumo-line bg-kumo-elevated p-3">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-kumo-tint text-kumo-default">
                        {newShareLinkCopied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                          {newShareLinkCopied ? 'Share link copied' : 'Share link created'}
                        </p>
                        <p className="mt-0.5 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                          {newShareLinkCopied
                            ? 'This link is shown once. Save it if you need to share it again.'
                            : 'Copy this link manually. It is shown once.'}
                        </p>
                        <div className="mt-2 flex items-center gap-2 rounded-lg border border-kumo-line bg-kumo-base px-2.5 py-1.5">
                          <span className="min-w-0 flex-1 truncate font-mono text-[12px] leading-4 text-kumo-subtle">
                            {newShareLink}
                          </span>
                          <WorkshopIconButton
                            className="!h-6 !w-6"
                            onClick={async () => {
                              const copied = await copyToClipboard(newShareLink)
                              toasts.add({
                                title: copied ? 'Share link copied.' : 'Could not copy share link.',
                                variant: copied ? 'success' : 'error',
                              })
                              if (copied) setNewShareLinkCopied(true)
                            }}
                            aria-label="Copy share link"
                          >
                            <Copy size={14} />
                          </WorkshopIconButton>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                <section>
                  <h3 className="mb-2 text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                    Existing links
                  </h3>
                  {shareKeys.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-kumo-line bg-kumo-base px-4 py-6 text-center">
                      <p className="text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                        No share links yet.
                      </p>
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
                      {shareKeys.map((sk, index) => {
                        const isRevoking = revokeTarget?.keyId === sk.keyId
                        return (
                        <div
                          key={sk.keyId}
                          className={`px-3 py-3 ${index > 0 ? 'border-t border-kumo-line' : ''} ${
                            isRevoking ? 'bg-kumo-danger-tint/40' : ''
                          }`}
                        >
                        {isRevoking ? (
                          <div className="space-y-3">
                          <div className="flex flex-wrap items-center gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-danger">
                                Revoke share link?
                              </p>
                              <p className="truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                                {revokeTarget.dependents.length > 0
                                  ? `${revokeTarget.dependents.length} user${revokeTarget.dependents.length === 1 ? '' : 's'} may lose access.`
                                  : 'Anyone with this URL will no longer be able to use it.'}
                              </p>
                            </div>
                            <WorkshopButton
                              tone="danger"
                              className="min-w-[68px]"
                              onClick={handleConfirmRevokeShareKey}
                              disabled={revokeLoadingKeyId === sk.keyId}
                            >
                              {revokeLoadingKeyId === sk.keyId ? 'Revoking...' : 'Revoke'}
                            </WorkshopButton>
                            <WorkshopButton
                              className="min-w-[64px]"
                              onClick={() => {
                                setRevokeTarget(null)
                                setRevokeKeepSet(new Set())
                              }}
                              disabled={revokeLoadingKeyId === sk.keyId}
                            >
                              Cancel
                            </WorkshopButton>
                          </div>
                          <DependentKeepList
                            dependents={revokeTarget.dependents}
                            keepSet={revokeKeepSet}
                            onKeepSetChange={setRevokeKeepSet}
                          />
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-3">
                          <div className="min-w-0 flex-1">
                            {editingShareKeyId === sk.keyId ? (
                              <div className="flex flex-col gap-2 sm:flex-row">
                                <WorkshopInput
                                  value={editingShareKeyNote}
                                  onChange={(e) => setEditingShareKeyNote(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSaveShareKeyNote()
                                    if (e.key === 'Escape') cancelEditingShareKeyNote()
                                  }}
                                  autoFocus
                                  placeholder="Note (optional)"
                                  aria-label="Share link note"
                                  className="flex-1"
                                />
                                <WorkshopButton
                                  tone="primary"
                                  className="min-w-[64px]"
                                  onClick={handleSaveShareKeyNote}
                                  disabled={savingShareKeyNote}
                                >
                                  Save
                                </WorkshopButton>
                                <WorkshopButton
                                  className="!h-9 min-w-[64px]"
                                  onClick={cancelEditingShareKeyNote}
                                  disabled={savingShareKeyNote}
                                >
                                  Cancel
                                </WorkshopButton>
                              </div>
                            ) : (
                              <>
                                <p className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                                  {sk.note || 'Untitled link'}
                                </p>
                                <p className="truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                                  Created {formatRelativeTime(sk.created)} by {sk.createdBy.name}
                                </p>
                              </>
                            )}
                          </div>
                          {editingShareKeyId !== sk.keyId && (
                            <>
                              <button
                                type="button"
                                onClick={() => startEditingShareKeyNote(sk)}
                                className="shrink-0 rounded-md px-2 py-1 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
                              >
                                {sk.note ? 'Edit note' : 'Add note'}
                              </button>
                              <WorkshopIconButton
                                danger
                                className="!h-7 !w-7"
                                onClick={() => handleStartRevokeShareKey(sk.keyId)}
                                aria-label="Revoke share link"
                                disabled={revokeLoadingKeyId === sk.keyId}
                              >
                                <Trash size={14} />
                              </WorkshopIconButton>
                            </>
                          )}
                          </div>
                        )}
                        </div>
                      )})}
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  )
}
