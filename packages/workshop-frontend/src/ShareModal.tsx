import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Checkbox, Dialog, DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import type { PortalContainer } from '@cloudflare/kumo'
import { CaretDown, Check, Copy, Link, PencilSimple, ShieldWarning, Trash, UserPlus, X } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import {
  Overseer,
  AuthenticatedApi,
  CollaboratorInfo,
  AffectedCollaborator,
  ShareKeyInfo,
  GadgetMetadata,
  AiChatAuthorInfo,
  CollaboratorRole,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton } from './components/WorkshopControls'
import { copyToClipboard } from './clipboard'
import { useAvatar } from './useAvatar'

type CollaboratorRow =
  | { kind: 'owner'; profile: AiChatAuthorInfo }
  | { kind: 'collaborator'; info: CollaboratorInfo }

type ConfirmationTarget =
  | { kind: 'remove'; profileId: string; dependents: AffectedCollaborator[]; previewing: boolean; keepSet: Set<string> }
  | { kind: 'revoke'; keyId: string; dependents: AffectedCollaborator[]; previewing: boolean; keepSet: Set<string> }

type Props = {
  open: boolean
  onClose: () => void
  overseer: RpcStub<Overseer>
  metadata: GadgetMetadata
  currentUser: AiChatAuthorInfo | null
  authenticatedApi: RpcStub<AuthenticatedApi>
}

function PersonAvatar({
  api,
  userId,
  name,
  size = 32,
}: {
  api: RpcStub<AuthenticatedApi>
  userId: string
  name: string
  size?: number
}) {
  const elementRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const element = elementRef.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '100px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const url = useAvatar(api, visible ? userId : null)
  return (
    <div
      ref={elementRef}
      className="relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-kumo-tint to-kumo-elevated text-[10px] font-semibold text-kumo-strong ring-1 ring-inset ring-kumo-line/60"
      style={{ width: size, height: size }}
    >
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        initials(name)
      )}
    </div>
  )
}

function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSeconds < 60) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

function initials(name: string) {
  return name.split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase()
}

const ROLE_LABELS: Record<CollaboratorRole, string> = {
  build: 'Can build',
  use: 'Can use',
}

const ROLE_DESCRIPTIONS: Record<CollaboratorRole, string> = {
  build: 'Edit the app, use chat, and manage access.',
  use: 'Use the app without agent chat or editing.',
}

function roleLabel(role: CollaboratorRole | undefined): string {
  return ROLE_LABELS[role ?? 'build']
}

const ROLE_OPTIONS: CollaboratorRole[] = ['build', 'use']

function RoleMenu({
  value,
  onValueChange,
  disabled,
  ariaLabel,
  container,
}: {
  value: CollaboratorRole
  onValueChange: (role: CollaboratorRole) => void
  disabled?: boolean
  ariaLabel: string
  container?: PortalContainer
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        disabled={disabled}
        render={
          <button
            type="button"
            className="group inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] leading-4 font-medium text-kumo-subtle transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.97] data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={ariaLabel}
          >
            {roleLabel(value)}
            <CaretDown size={11} weight="bold" className="text-kumo-inactive transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180" />
          </button>
        }
      />
      <DropdownMenu.Content
        container={container}
        align="end"
        sideOffset={6}
        className="!z-[1100] !w-[300px] !min-w-0 rounded-2xl border border-kumo-line/70 bg-kumo-base p-1 shadow-[0_14px_36px_rgba(82,16,0,0.10)] !ring-kumo-line"
      >
        {ROLE_OPTIONS.map(role => (
          <DropdownMenu.Item
            key={role}
            onClick={() => onValueChange(role)}
            className="!h-auto cursor-pointer rounded-xl !px-2.5 !py-2 text-kumo-default transition-colors data-highlighted:bg-kumo-tint/70"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] leading-4 font-medium">{roleLabel(role)}</span>
              <span className="mt-0.5 block text-[11px] leading-4 font-normal text-kumo-subtle">
                {ROLE_DESCRIPTIONS[role]}
              </span>
            </span>
            <span className="ml-2 flex h-4 w-4 shrink-0 items-center justify-center">
              {value === role && <Check size={13} weight="bold" className="text-kumo-brand" />}
            </span>
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

function RoleBadge({ role }: { role: CollaboratorRole | undefined }) {
  const isBuild = (role ?? 'build') === 'build'
  return (
    <span
      className={`shrink-0 rounded-full border px-2.5 py-[3px] text-[11px] leading-4 font-medium tracking-[-0.1px] ${
        isBuild
          ? 'border-kumo-line bg-kumo-tint/70 text-kumo-default'
          : 'border-kumo-line/70 bg-kumo-base text-kumo-subtle'
      }`}
    >
      {roleLabel(role)}
    </span>
  )
}

function InlineConfirm({
  label,
  busy,
  busyLabel,
  tone = 'danger',
  onConfirm,
  onCancel,
}: {
  label: string
  busy: boolean
  busyLabel?: string
  tone?: 'danger' | 'brand'
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex items-center gap-1 share-confirm-in">
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        className={`inline-flex h-7 cursor-pointer items-center rounded-lg px-2.5 text-[12px] leading-4 font-medium tracking-[-0.1px] transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] disabled:opacity-60 ${
          tone === 'danger'
            ? 'text-kumo-danger hover:bg-kumo-danger-tint'
            : 'text-kumo-brand hover:bg-kumo-tint'
        }`}
      >
        {busy ? (busyLabel ?? `${label}…`) : label}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        aria-label="Cancel"
        className="grid h-7 w-7 cursor-pointer place-items-center rounded-lg text-kumo-inactive transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default active:scale-[0.96] disabled:opacity-60"
      >
        <X size={14} />
      </button>
    </div>
  )
}

function DependentKeepList({
  dependents,
  keepSet,
  onKeepSetChange,
}: {
  dependents: AffectedCollaborator[]
  keepSet: Set<string>
  onKeepSetChange: (next: Set<string>) => void
}) {
  if (dependents.length === 0) return null

  return (
    <div className="space-y-1.5">
      {dependents.map(dep => (
        <div
          key={dep.profile.id}
          className={`rounded-xl px-3 py-2 transition-colors ${
            keepSet.has(dep.profile.id) ? 'bg-kumo-tint' : 'bg-kumo-elevated/50 hover:bg-kumo-elevated'
          }`}
        >
          <Checkbox
            label={(
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate text-[12px] font-medium text-kumo-default">{dep.profile.name}</span>
                <span className="truncate text-[11px] text-kumo-subtle">{dep.profile.id}</span>
              </span>
            )}
            checked={keepSet.has(dep.profile.id)}
            onCheckedChange={(checked) => {
              const next = new Set(keepSet)
              if (checked) next.add(dep.profile.id)
              else next.delete(dep.profile.id)
              onKeepSetChange(next)
            }}
          />
        </div>
      ))}
    </div>
  )
}

export default function ShareModal({ open, onClose, overseer, metadata, currentUser, authenticatedApi }: Props) {
  const toasts = useKumoToastManager()
  const [collaborators, setCollaborators] = useState<CollaboratorInfo[]>([])
  const [shareKeys, setShareKeys] = useState<ShareKeyInfo[]>([])
  const [addUsername, setAddUsername] = useState('')
  const [addRole, setAddRole] = useState<CollaboratorRole>('use')
  const [adding, setAdding] = useState(false)
  const [newLinkRole, setNewLinkRole] = useState<CollaboratorRole>('use')
  const [newLinkNote, setNewLinkNote] = useState('')
  const [newShareLink, setNewShareLink] = useState<string | null>(null)
  const [newShareKeyId, setNewShareKeyId] = useState<string | null>(null)
  const [newShareLinkCopied, setNewShareLinkCopied] = useState(false)
  const [creatingKey, setCreatingKey] = useState(false)
  const [showLinkComposer, setShowLinkComposer] = useState(false)
  const [confirmationTarget, setConfirmationTarget] = useState<ConfirmationTarget | null>(null)
  const [confirmationBusy, setConfirmationBusy] = useState(false)
  const wasOpenRef = useRef(false)
  const creatingKeyRef = useRef(false)
  const addingRef = useRef(false)
  const landedTimerRef = useRef<number | null>(null)
  const [menuContainer, setMenuContainer] = useState<PortalContainer>(null)
  const [scrolled, setScrolled] = useState(false)
  const [landedPersonId, setLandedPersonId] = useState<string | null>(null)
  const [landedShareKeyId, setLandedShareKeyId] = useState<string | null>(null)
  const [editingShareKeyId, setEditingShareKeyId] = useState<string | null>(null)
  const [editingShareKeyNote, setEditingShareKeyNote] = useState('')
  const [savingShareKeyNote, setSavingShareKeyNote] = useState(false)
  const linkNameRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const savingShareKeyNoteRef = useRef(false)

  // Focus the link-name field when the composer opens, without scrolling the sticky region
  // (autoFocus would jump the scroll position and shift layout).
  useEffect(() => {
    if (showLinkComposer && !newShareLink) {
      linkNameRef.current?.focus({ preventScroll: true })
    }
  }, [showLinkComposer, newShareLink])

  useEffect(() => {
    if (editingShareKeyId) {
      renameInputRef.current?.focus({ preventScroll: true })
      renameInputRef.current?.select()
    }
  }, [editingShareKeyId])

  useEffect(() => {
    return () => {
      if (landedTimerRef.current !== null) window.clearTimeout(landedTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const element = document.createElement('div')
    element.style.position = 'relative'
    element.style.zIndex = '1100'
    document.body.appendChild(element)
    setMenuContainer(element)
    return () => {
      setMenuContainer(null)
      element.remove()
    }
  }, [])

  const isOwner = !metadata.owner
  const sharingProhibited = metadata.sharingProhibited === true

  const loadData = useCallback(async () => {
    try {
      const [collabs, keys] = await Promise.all([
        overseer.listCollaborators(),
        overseer.listShareKeys(),
      ])
      setCollaborators(collabs)
      setShareKeys(keys)
      return { collaborators: collabs, shareKeys: keys }
    } catch (err) {
      console.error('Failed to load share data:', err)
      toasts.add({ title: 'Failed to load sharing info', variant: 'error' })
      return null
    }
  }, [overseer])

  useEffect(() => {
    if (open) {
      loadData()
      if (!wasOpenRef.current) {
        setAddUsername('')
        setNewShareLink(null)
        setNewShareKeyId(null)
        setNewShareLinkCopied(false)
        setNewLinkNote('')
        setShowLinkComposer(false)
        setConfirmationTarget(null)
        setEditingShareKeyId(null)
        setEditingShareKeyNote('')
      }
    }
    wasOpenRef.current = open
  }, [open, loadData])

  const ownerProfile: AiChatAuthorInfo | null = isOwner ? currentUser : (metadata.owner ?? null)
  const collaboratorRows: CollaboratorRow[] = [
    ...(ownerProfile ? [{ kind: 'owner' as const, profile: ownerProfile }] : []),
    ...collaborators.map(info => ({ kind: 'collaborator' as const, info })),
  ]
  const sortedShareKeys = useMemo(
    () => [...shareKeys].toSorted((a, b) => b.created.getTime() - a.created.getTime()),
    [shareKeys],
  )
  const removeTarget = confirmationTarget?.kind === 'remove' ? confirmationTarget : null
  const revokeTarget = confirmationTarget?.kind === 'revoke' ? confirmationTarget : null

  const describeAccess = (info: CollaboratorInfo): string => {
    if (info.addedBy.length > 1) return `Access from ${info.addedBy.length} sources`
    const edge = info.addedBy[0]
    if (!edge) return 'Collaborator'
    if (edge.type === 'user') return `Added directly by ${edge.sharer}`
    const key = shareKeys.find(item => item.keyId === edge.keyId)
    return key?.note ? `Joined through “${key.note}”` : 'Joined through a share link'
  }

  const copyNewLink = async () => {
    if (!newShareLink) return
    const copied = await copyToClipboard(newShareLink)
    if (copied) {
      setNewShareLinkCopied(true)
    } else {
      toasts.add({ title: 'Could not copy share link.', variant: 'error' })
    }
  }

  const showLandedRow = (kind: 'person' | 'shareKey', id: string) => {
    if (landedTimerRef.current !== null) window.clearTimeout(landedTimerRef.current)
    setLandedPersonId(kind === 'person' ? id : null)
    setLandedShareKeyId(kind === 'shareKey' ? id : null)
    landedTimerRef.current = window.setTimeout(() => {
      setLandedPersonId(null)
      setLandedShareKeyId(null)
      landedTimerRef.current = null
    }, 2200)
  }

  const handleAddCollaborator = async () => {
    const username = addUsername.trim()
    if (!username || sharingProhibited || addingRef.current) return

    addingRef.current = true
    setAdding(true)
    try {
      const result = await overseer.addCollaborator(username, addRole, undefined)
      if (result === null) {
        toasts.add({ title: 'No account found for that username.', variant: 'error' })
      } else {
        const landedId = result.profile.id
        setAddUsername('')
        await loadData()
        showLandedRow('person', landedId)
        toasts.add({ title: `Added ${result.profile.name} as a collaborator.`, variant: 'success' })
      }
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to add collaborator.', variant: 'error' })
    } finally {
      addingRef.current = false
      setAdding(false)
    }
  }

  const handleCreateShareKey = async () => {
    if (sharingProhibited || creatingKeyRef.current) return
    creatingKeyRef.current = true
    setCreatingKey(true)
    try {
      const previousKeyIds = new Set(shareKeys.map(shareKey => shareKey.keyId))
      const { key } = await overseer.createShareKey(newLinkRole, newLinkNote.trim() || undefined)
      const url = `${window.location.origin}/gadget/${metadata.id}#share=${key}`
      setNewShareLink(url)
      setNewShareLinkCopied(false)
      setNewLinkNote('')
      const loaded = await loadData()
      const createdShareKey = loaded?.shareKeys.find(shareKey => !previousKeyIds.has(shareKey.keyId))
      if (createdShareKey) {
        setNewShareKeyId(createdShareKey.keyId)
        showLandedRow('shareKey', createdShareKey.keyId)
      }
    } catch (err: any) {
      // Keep the composer and its values open so the user can retry without re-entering them.
      toasts.add({ title: err.message || 'Failed to create share link.', variant: 'error' })
    } finally {
      creatingKeyRef.current = false
      setCreatingKey(false)
    }
  }

  const handleStartRemoveCollaborator = async (profileId: string) => {
    setConfirmationTarget({ kind: 'remove', profileId, dependents: [], previewing: true, keepSet: new Set() })
    try {
      const dependents = await overseer.previewRemoveCollaborator(profileId)
      setConfirmationTarget(current => current?.kind === 'remove' && current.profileId === profileId
        ? { ...current, dependents, previewing: false }
        : current)
    } catch (err: any) {
      setConfirmationTarget(current => current?.kind === 'remove' && current.profileId === profileId ? null : current)
      toasts.add({ title: err.message || 'Failed to preview collaborator removal.', variant: 'error' })
    }
  }

  const handleConfirmRemoveCollaborator = async () => {
    if (!removeTarget || removeTarget.previewing || confirmationBusy) return
    setConfirmationBusy(true)
    try {
      const removed = await overseer.removeCollaborator(removeTarget.profileId, [...removeTarget.keepSet])
      setConfirmationTarget(null)
      toasts.add({
        title: removed.length > 0
          ? 'Collaborator removed.'
          : 'Your direct grant was removed. This collaborator still has access through another source.',
        variant: 'success',
      })
      await loadData()
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to remove collaborator.', variant: 'error' })
    } finally {
      setConfirmationBusy(false)
    }
  }

  const startRenameShareKey = (shareKey: ShareKeyInfo) => {
    // Renaming and the destructive confirm are mutually exclusive in-place editors on the same row.
    setConfirmationTarget(null)
    setEditingShareKeyId(shareKey.keyId)
    setEditingShareKeyNote(shareKey.note ?? '')
  }

  const cancelRenameShareKey = () => {
    setEditingShareKeyId(null)
    setEditingShareKeyNote('')
  }

  const handleSaveShareKeyNote = async () => {
    if (!editingShareKeyId || savingShareKeyNoteRef.current) return
    const keyId = editingShareKeyId
    savingShareKeyNoteRef.current = true
    setSavingShareKeyNote(true)
    try {
      await overseer.updateShareKey(keyId, editingShareKeyNote.trim() || undefined)
      cancelRenameShareKey()
      await loadData()
      showLandedRow('shareKey', keyId)
      toasts.add({ title: 'Share link renamed.', variant: 'success' })
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to rename share link.', variant: 'error' })
    } finally {
      savingShareKeyNoteRef.current = false
      setSavingShareKeyNote(false)
    }
  }

  const handleStartRevokeShareKey = async (keyId: string) => {
    cancelRenameShareKey()
    setConfirmationTarget({ kind: 'revoke', keyId, dependents: [], previewing: true, keepSet: new Set() })
    try {
      const dependents = await overseer.previewRevokeShareKey(keyId)
      setConfirmationTarget(current => current?.kind === 'revoke' && current.keyId === keyId
        ? { ...current, dependents, previewing: false }
        : current)
    } catch (err: any) {
      setConfirmationTarget(current => current?.kind === 'revoke' && current.keyId === keyId ? null : current)
      toasts.add({ title: err.message || 'Failed to preview share-link revocation.', variant: 'error' })
    }
  }

  const handleConfirmRevokeShareKey = async () => {
    if (!revokeTarget || revokeTarget.previewing || confirmationBusy) return
    setConfirmationBusy(true)
    try {
      await overseer.revokeShareKey(revokeTarget.keyId, [...revokeTarget.keepSet])
      setConfirmationTarget(null)
      if (revokeTarget.keyId === newShareKeyId) {
        setNewShareLink(null)
        setNewShareKeyId(null)
        setNewShareLinkCopied(false)
        setShowLinkComposer(false)
      }
      toasts.add({ title: 'Share link revoked.', variant: 'success' })
      await loadData()
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to revoke share link.', variant: 'error' })
    } finally {
      setConfirmationBusy(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog
        className="!z-[1000] !top-[clamp(24px,10vh,80px)] !flex !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !w-[min(640px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0 !outline-none"
        size="lg"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 overflow-hidden px-4 pb-4 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <Dialog.Title className="truncate text-[18px] leading-6 font-medium tracking-[-0.4px] text-kumo-default">
              Share “{metadata.title}”
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
              Invite people or share a link.
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton {...props} aria-label="Close">
                <X size={18} />
              </WorkshopIconButton>
            )}
          />
        </div>

        <div
          className="chat-panel min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 sm:px-6"
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        >
          {sharingProhibited ? (
            <div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-kumo-warning-tint text-kumo-warning">
                <ShieldWarning size={22} weight="duotone" />
              </div>
              <p className="mt-3 text-[14px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
                This gadget can’t be shared
              </p>
              <p className="mt-1.5 max-w-[320px] text-balance text-[12px] leading-[18px] tracking-[-0.1px] text-kumo-subtle">
                It has observed sensitive data that can only be accessed by you, the owner.
              </p>
              <p className="mt-2 max-w-[320px] text-balance text-[12px] leading-[18px] tracking-[-0.1px] text-kumo-subtle">
                To share something similar, create a new gadget or fork this one by creating a blueprint.
              </p>
            </div>
          ) : (
          <>
          <div className={`sticky top-0 z-10 bg-kumo-base pb-3 transition-shadow duration-200 ${scrolled ? 'border-b border-kumo-line/60 shadow-[0_4px_10px_-8px_rgba(82,16,0,0.10)]' : ''}`}>
          <div
            className="grid min-h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-2xl border border-kumo-line/80 bg-kumo-base p-1.5 pl-3 shadow-[0_8px_24px_-20px_rgba(82,16,0,0.28)] transition-[border-color,box-shadow] focus-within:border-kumo-fill focus-within:shadow-[0_10px_28px_-20px_rgba(82,16,0,0.34)] sm:flex sm:overflow-hidden"
            data-keeper-ignore="true"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
          >
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
              <UserPlus size={15} weight="duotone" />
            </div>
            <input
              type="search"
              placeholder="Username or email"
              aria-label="Username or email"
              value={addUsername}
              onChange={(e) => setAddUsername(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAddCollaborator() }}
              name="gadget-share-people-search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              data-keeper-ignore="true"
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              data-form-type="other"
              className="h-9 min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-[14px] leading-5 tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive disabled:cursor-not-allowed [&::-webkit-search-cancel-button]:hidden"
              disabled={sharingProhibited}
            />
            <RoleMenu
              ariaLabel="Access to grant"
              value={addRole}
              onValueChange={setAddRole}
              disabled={sharingProhibited}
              container={menuContainer}
            />
            <WorkshopButton
              tone="primary"
              className="col-span-3 w-full !rounded-xl sm:col-span-1 sm:w-auto sm:min-w-[68px]"
              onClick={handleAddCollaborator}
              disabled={!addUsername.trim() || adding || sharingProhibited}
            >
              {adding ? 'Inviting…' : 'Invite'}
            </WorkshopButton>
          </div>

          <div className="mt-2">
            {(showLinkComposer || newShareLink) ? (
              newShareLink ? (
                <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-kumo-line/80 bg-kumo-base px-3 py-2.5 shadow-[0_8px_24px_-20px_rgba(82,16,0,0.28)] share-fade-in">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
                      {newShareLinkCopied ? <Check size={15} weight="bold" /> : <Link size={15} />}
                    </div>
                    <div className="min-w-[160px] flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <p className="text-[13px] leading-[18px] font-medium text-kumo-default">
                          {newShareLinkCopied ? 'Link copied' : 'Link ready'}
                        </p>
                        <span className="text-[11px] leading-4 text-kumo-inactive">
                          Copy it now, it won’t be shown again
                        </span>
                      </div>
                      <p className="truncate font-mono text-[11px] leading-4 text-kumo-subtle">{newShareLink}</p>
                    </div>
                    <WorkshopButton tone="primary" onClick={copyNewLink} className="w-[78px] gap-1.5 !rounded-xl">
                      {newShareLinkCopied ? <Check size={13} weight="bold" /> : <Copy size={13} />}
                      {newShareLinkCopied ? 'Copied' : 'Copy'}
                    </WorkshopButton>
                    <WorkshopIconButton
                      aria-label="Dismiss created link"
                      onClick={() => { setNewShareLink(null); setNewShareKeyId(null); setNewShareLinkCopied(false); setShowLinkComposer(false) }}
                    >
                      <X size={14} />
                    </WorkshopIconButton>
                </div>
              ) : (
                <div className="flex h-12 items-center gap-2 overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base p-1.5 pl-3 shadow-[0_8px_24px_-20px_rgba(82,16,0,0.28)] transition-[border-color,box-shadow] focus-within:border-kumo-fill focus-within:shadow-[0_10px_28px_-20px_rgba(82,16,0,0.34)] share-fade-in">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
                      <Link size={15} />
                    </div>
                    <input
                      ref={linkNameRef}
                      value={newLinkNote}
                      onChange={(e) => setNewLinkNote(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleCreateShareKey() }}
                      placeholder="Name this link (optional)…"
                      aria-label="Share link name (optional)"
                      className="h-9 min-w-0 flex-1 border-0 bg-transparent p-0 text-[14px] leading-5 tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive"
                      disabled={creatingKey || sharingProhibited}
                    />
                    <RoleMenu
                      ariaLabel="Access granted by link"
                      value={newLinkRole}
                      onValueChange={setNewLinkRole}
                      disabled={creatingKey || sharingProhibited}
                      container={menuContainer}
                    />
                    <WorkshopButton tone="primary" className="shrink-0 !rounded-xl" onClick={handleCreateShareKey} disabled={creatingKey || sharingProhibited}>
                      {creatingKey ? 'Creating…' : 'Create link'}
                    </WorkshopButton>
                    <WorkshopIconButton aria-label="Cancel creating link" onClick={() => setShowLinkComposer(false)}>
                      <X size={14} />
                    </WorkshopIconButton>
                </div>
              )
            ) : (
              <button
                type="button"
                onClick={() => setShowLinkComposer(true)}
                disabled={sharingProhibited}
                className="flex h-12 w-full cursor-pointer items-center justify-center gap-1.5 rounded-2xl border border-kumo-line/80 bg-kumo-base px-3 text-[13px] font-medium text-kumo-subtle shadow-[0_8px_24px_-20px_rgba(82,16,0,0.28)] transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-elevated/60 hover:text-kumo-default active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Link size={14} /> Create a share link
              </button>
            )}
          </div>
          </div>

          <section aria-labelledby="people-heading" className="mt-1">
            <div className="mb-2 px-1">
              <h3 id="people-heading" className="text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-subtle">
                People with access
              </h3>
            </div>
            <div className="overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base">
              {collaboratorRows.map((row, index) => {
                const profile = row.kind === 'owner' ? row.profile : row.info.profile
                const key = row.kind === 'owner' ? '__owner__' : row.info.profile.id
                const isRemoving = row.kind === 'collaborator' && removeTarget?.profileId === row.info.profile.id
                const downstreamDependents = isRemoving && removeTarget
                  ? removeTarget.dependents.filter(dep => dep.profile.id !== profile.id)
                  : []
                return (
                  <div key={key} className={`group ${index > 0 ? 'border-t border-kumo-line/70' : ''} ${landedPersonId === profile.id ? 'share-row-land' : 'transition-colors duration-150 hover:bg-kumo-elevated/50'} px-3 py-2.5`}>
                    <div className="flex items-center gap-3">
                      <PersonAvatar api={authenticatedApi} userId={profile.id} name={profile.name} size={32} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default">
                          {profile.name}{profile.id === currentUser?.id ? ' (you)' : ''}
                        </p>
                        <p className="truncate text-[12px] leading-[15px] tracking-[-0.15px] text-kumo-subtle">
                          {row.kind === 'owner' ? profile.id : describeAccess(row.info)}
                        </p>
                      </div>
                      {row.kind === 'owner' ? (
                        <span className="px-2 text-[12px] text-kumo-subtle">Owner</span>
                      ) : isRemoving ? (
                        <InlineConfirm
                          label="Remove"
                          busy={removeTarget.previewing || confirmationBusy}
                          busyLabel={removeTarget.previewing ? 'Checking…' : undefined}
                          onConfirm={handleConfirmRemoveCollaborator}
                          onCancel={() => setConfirmationTarget(null)}
                        />
                      ) : (
                        <>
                          <RoleBadge role={row.info.role} />
                          <WorkshopIconButton
                            danger
                            className="!h-7 !w-7 opacity-35 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                            onClick={() => handleStartRemoveCollaborator(row.info.profile.id)}
                            aria-label={`Remove ${profile.name}`}
                            disabled={confirmationBusy}
                          >
                            <Trash size={13} />
                          </WorkshopIconButton>
                        </>
                      )}
                    </div>
                    {isRemoving && downstreamDependents.length > 0 && (
                      <div className="mt-2.5 share-expand-in">
                        <p className="mb-1.5 text-[12px] leading-4 text-kumo-subtle">
                          {downstreamDependents.length} other {downstreamDependents.length === 1 ? 'person loses' : 'people lose'} access through {profile.name}. Keep anyone?
                        </p>
                        <DependentKeepList
                          dependents={downstreamDependents}
                          keepSet={removeTarget.keepSet}
                          onKeepSetChange={(keepSet) => setConfirmationTarget(current =>
                            current?.kind === 'remove' && current.profileId === removeTarget.profileId
                              ? { ...current, keepSet }
                              : current
                          )}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

          {shareKeys.length > 0 && (
          <section aria-labelledby="links-heading" className="mt-4">
            <div className="mb-2 px-1">
              <h3 id="links-heading" className="text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-subtle">
                Share links
              </h3>
            </div>

              <div className="overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base">
                {sortedShareKeys.map((sk, index) => {
                  const isRevoking = revokeTarget?.keyId === sk.keyId
                  const isRenaming = editingShareKeyId === sk.keyId
                  return (
                    <div key={sk.keyId} className={`group ${index > 0 ? 'border-t border-kumo-line/70' : ''} ${landedShareKeyId === sk.keyId ? 'share-row-land' : 'transition-colors duration-150 hover:bg-kumo-elevated/50'} px-3 py-2.5`}>
                      <div className="flex items-center gap-3">
                        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-kumo-tint to-kumo-elevated text-kumo-subtle ring-1 ring-inset ring-kumo-line/60">
                          <Link size={14} />
                        </div>
                        <div className="min-w-0 flex-1">
                          {isRenaming ? (
                            <input
                              ref={renameInputRef}
                              value={editingShareKeyNote}
                              onChange={(e) => setEditingShareKeyNote(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleSaveShareKeyNote()
                                if (e.key === 'Escape') cancelRenameShareKey()
                              }}
                              placeholder="Name this link…"
                              aria-label="Share link name"
                              className="block w-full border-0 bg-transparent p-0 text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default outline-none shadow-[inset_0_-1px_0_0_var(--color-kumo-line)] transition-shadow placeholder:font-normal placeholder:text-kumo-inactive focus:shadow-[inset_0_-1px_0_0_var(--color-kumo-fill)]"
                              disabled={savingShareKeyNote}
                            />
                          ) : (
                            <p className="truncate text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default">{sk.note || 'Untitled link'}</p>
                          )}
                          <p className="truncate text-[12px] leading-[15px] tracking-[-0.15px] text-kumo-subtle">Created by {sk.createdBy.name} · {formatRelativeTime(sk.created)}</p>
                        </div>
                        {isRenaming ? (
                          <InlineConfirm
                            label="Save"
                            tone="brand"
                            busy={savingShareKeyNote}
                            onConfirm={handleSaveShareKeyNote}
                            onCancel={cancelRenameShareKey}
                          />
                        ) : isRevoking ? (
                          <InlineConfirm
                            label="Revoke"
                            busy={revokeTarget.previewing || confirmationBusy}
                            busyLabel={revokeTarget.previewing ? 'Checking…' : undefined}
                            onConfirm={handleConfirmRevokeShareKey}
                            onCancel={() => setConfirmationTarget(null)}
                          />
                        ) : (
                          <>
                            <RoleBadge role={sk.role} />
                            <WorkshopIconButton
                              className="!h-7 !w-7 opacity-35 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                              onClick={() => startRenameShareKey(sk)}
                              aria-label={`Rename ${sk.note || 'share link'}`}
                              disabled={confirmationBusy}
                            >
                              <PencilSimple size={13} />
                            </WorkshopIconButton>
                            <WorkshopIconButton
                              danger
                              className="!h-7 !w-7 opacity-35 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                              onClick={() => handleStartRevokeShareKey(sk.keyId)}
                              aria-label={`Revoke ${sk.note || 'share link'}`}
                              disabled={confirmationBusy}
                            >
                              <Trash size={13} />
                            </WorkshopIconButton>
                          </>
                        )}
                      </div>
                      {isRevoking && revokeTarget.dependents.length > 0 && (
                        <div className="mt-2.5 share-expand-in">
                          <p className="mb-1.5 text-[12px] leading-4 text-kumo-subtle">
                            {revokeTarget.dependents.length} {revokeTarget.dependents.length === 1 ? 'person loses' : 'people lose'} access through this link. Keep anyone?
                          </p>
                          <DependentKeepList
                            dependents={revokeTarget.dependents}
                            keepSet={revokeTarget.keepSet}
                            onKeepSetChange={(keepSet) => setConfirmationTarget(current =>
                              current?.kind === 'revoke' && current.keyId === revokeTarget.keyId
                                ? { ...current, keepSet }
                                : current
                            )}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
          </section>
          )}
          </>
          )}
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
