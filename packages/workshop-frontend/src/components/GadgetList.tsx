import { Link } from '@tanstack/react-router'
import { Clock, MagnifyingGlass, Hexagon, DotsThreeVertical, ShareNetwork, Trash, Info, PushPin, Pencil } from '@phosphor-icons/react'
import { useState, useEffect, useRef } from 'react'
import { DropdownMenu, Dialog, Button, useKumoToastManager } from '@cloudflare/kumo'
import { RpcStub } from 'capnweb'
import { useAuthenticatedApi } from '../AuthContext'
import { GadgetMetadataWithTimestamps, Overseer, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import ShareModal from '../ShareModal'

// Deterministic gradient by gadget ID
const gradients = [
  'from-[#4A154B] to-[#7C3085]',
  'from-[#0052CC] to-[#2684FF]',
  'from-[#5865F2] to-[#7983F5]',
  'from-[#34A853] to-[#4285F4]',
  'from-[#24292e] to-[#555]',
  'from-[#E01E5A] to-[#ECB22E]',
  'from-orange-600 to-red-600',
  'from-emerald-600 to-teal-600',
]

function getGradient(id: string) {
  return gradients[id.charCodeAt(0) % gradients.length]
}

function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`
}

function AppRow({
  gadget,
  onDelete,
  onShare,
  onInfo,
  onTogglePin,
  onRename,
}: {
  gadget: GadgetMetadataWithTimestamps
  onDelete: (gadget: GadgetMetadataWithTimestamps) => void
  onShare: (gadget: GadgetMetadataWithTimestamps) => void
  onInfo: (gadget: GadgetMetadataWithTimestamps) => void
  onTogglePin: (gadget: GadgetMetadataWithTimestamps) => void
  onRename: (gadget: GadgetMetadataWithTimestamps, newTitle: string) => void
}) {
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(gadget.title || '')
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isRenaming) renameInputRef.current?.focus()
  }, [isRenaming])

  const commitRename = () => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== gadget.title) {
      onRename(gadget, trimmed)
    }
    setIsRenaming(false)
  }

  const startRenaming = () => {
    setRenameValue(gadget.title || '')
    setIsRenaming(true)
  }

  return (
    <Link
      to="/gadget/$id"
      params={{ id: gadget.id }}
      className="group flex items-center gap-3 px-3 py-2.5 mr-4 sm:mr-6 rounded-xl border border-transparent hover:border-kumo-fill hover:bg-kumo-elevated transition-all cursor-pointer"
      onClick={(e) => {
        // Prevent navigation when renaming or clicking the menu
        if (isRenaming) e.preventDefault()
      }}
    >
      {/* Gradient swatch */}
      <div
        className={`w-9 h-9 rounded-lg bg-gradient-to-br ${getGradient(gadget.id)} flex-shrink-0 flex items-center justify-center`}
      >
        <Hexagon size={14} className="text-white/70" weight="bold" />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {gadget.pinned && <PushPin size={12} weight="fill" className="text-kumo-brand flex-shrink-0" />}
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename()
                if (e.key === 'Escape') setIsRenaming(false)
              }}
              className="text-sm font-medium text-kumo-default bg-transparent border-b border-kumo-brand outline-none w-full min-w-0"
              onClick={(e) => e.preventDefault()}
            />
          ) : (
            <h3 className="text-sm font-medium text-kumo-default truncate">
              {gadget.title || 'Untitled Gadget'}
            </h3>
          )}
        </div>
        {gadget.owner && (
          <p className="text-xs text-kumo-subtle truncate mt-0.5">
            Shared by {gadget.owner.name}
          </p>
        )}
      </div>

      {/* Time */}
      <span className="hidden lg:flex items-center gap-1 text-xs text-kumo-inactive flex-shrink-0">
        <Clock size={10} />
        {formatRelativeTime(gadget.lastActive)}
      </span>

      {/* Overflow menu — wrapper stops clicks from reaching the parent Link */}
      <div onClick={(e) => { e.stopPropagation(); e.preventDefault() }}>
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <button
              className="p-1.5 text-kumo-subtle hover:text-kumo-default rounded-md hover:bg-kumo-tint transition-colors sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
            >
              <DotsThreeVertical size={16} />
            </button>
          }
        />
        <DropdownMenu.Content>
          <DropdownMenu.Item onClick={startRenaming}>
            <Pencil size={14} className="mr-2" />
            Rename
          </DropdownMenu.Item>
          <DropdownMenu.Item onClick={() => onTogglePin(gadget)}>
            <PushPin size={14} className="mr-2" weight={gadget.pinned ? 'fill' : 'regular'} />
            {gadget.pinned ? 'Unpin' : 'Pin to top'}
          </DropdownMenu.Item>
          <DropdownMenu.Item onClick={() => onInfo(gadget)}>
            <Info size={14} className="mr-2" />
            Information
          </DropdownMenu.Item>
          <DropdownMenu.Item onClick={() => onShare(gadget)}>
            <ShareNetwork size={14} className="mr-2" />
            Share
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item
            variant="danger"
            onClick={() => onDelete(gadget)}
          >
            <Trash size={14} className="mr-2" />
            {gadget.owner ? 'Dismiss' : 'Delete'}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
      </div>
    </Link>
  )
}

export default function GadgetList() {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [gadgets, setGadgets] = useState<GadgetMetadataWithTimestamps[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<GadgetMetadataWithTimestamps | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Info modal state
  const [infoTarget, setInfoTarget] = useState<GadgetMetadataWithTimestamps | null>(null)

  // Share modal state
  const [shareTarget, setShareTarget] = useState<GadgetMetadataWithTimestamps | null>(null)
  const [shareOverseer, setShareOverseer] = useState<{ stub: RpcStub<Overseer> } | null>(null)
  const [userInfo, setUserInfo] = useState<AiChatAuthorInfo | null>(null)

  useEffect(() => {
    authenticatedApi.whoami().then(setUserInfo).catch(() => {})
  }, [authenticatedApi])

  const loadGadgets = () => {
    setLoading(true)
    setLoadError(false)
    let cancelled = false
    authenticatedApi.listGadgets().then((list) => {
      if (cancelled) return
      const sorted = [...list].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1
        if (!a.pinned && b.pinned) return 1
        return b.lastActive.getTime() - a.lastActive.getTime()
      })
      setGadgets(sorted)
      setLoading(false)
    }).catch((err) => {
      console.error('Failed to load gadgets:', err)
      if (!cancelled) { setLoading(false); setLoadError(true) }
    })
    return () => { cancelled = true }
  }

  useEffect(() => loadGadgets(), [authenticatedApi])

  // Clean up share overseer when modal closes
  useEffect(() => {
    if (!shareTarget && shareOverseer) {
      shareOverseer.stub[Symbol.dispose]()
      setShareOverseer(null)
    }
  }, [shareTarget, shareOverseer])

  // Dispose share overseer on unmount if still open
  const shareOverseerRef = useRef(shareOverseer)
  shareOverseerRef.current = shareOverseer
  useEffect(() => {
    return () => { shareOverseerRef.current?.stub[Symbol.dispose]() }
  }, [])

  const handleDelete = (gadget: GadgetMetadataWithTimestamps) => {
    setDeleteTarget(gadget)
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    setIsDeleting(true)
    try {
      if (deleteTarget.owner) {
        await authenticatedApi.dismissSharedGadget(deleteTarget.id)
        toasts.add({ title: 'Gadget removed from list', variant: 'success' })
      } else {
        const overseer = await authenticatedApi.openGadget(deleteTarget.id)
        try {
          await overseer.deleteSelf()
        } finally {
          overseer[Symbol.dispose]()
        }
        toasts.add({ title: 'Gadget deleted', variant: 'success' })
      }
      setGadgets(prev => prev.filter(g => g.id !== deleteTarget.id))
    } catch (err) {
      console.error('Failed to delete gadget:', err)
      toasts.add({ title: 'Failed to delete gadget', variant: 'error' })
    } finally {
      setIsDeleting(false)
      setDeleteTarget(null)
    }
  }

  const handleShare = async (gadget: GadgetMetadataWithTimestamps) => {
    try {
      const overseer = await authenticatedApi.openGadget(gadget.id)
      setShareOverseer({ stub: overseer })
      setShareTarget(gadget)
    } catch (err) {
      console.error('Failed to open gadget for sharing:', err)
      toasts.add({ title: 'Failed to open share settings', variant: 'error' })
    }
  }

  const handleTogglePin = async (gadget: GadgetMetadataWithTimestamps) => {
    const newPinned = !gadget.pinned
    // Optimistically update the list
    setGadgets(prev => {
      const updated = prev.map(g => g.id === gadget.id ? { ...g, pinned: newPinned } : g)
      return updated.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1
        if (!a.pinned && b.pinned) return 1
        return b.lastActive.getTime() - a.lastActive.getTime()
      })
    })
    // Use promise pipelining — call setPinned without awaiting openGadget first
    const overseer = authenticatedApi.openGadget(gadget.id)
    try {
      await overseer.setPinned(newPinned)
    } catch (err) {
      console.error('Failed to pin gadget:', err)
      setGadgets(prev => {
        const reverted = prev.map(g => g.id === gadget.id ? { ...g, pinned: gadget.pinned } : g)
        return reverted.sort((a, b) => {
          if (a.pinned && !b.pinned) return -1
          if (!a.pinned && b.pinned) return 1
          return b.lastActive.getTime() - a.lastActive.getTime()
        })
      })
      toasts.add({ title: 'Failed to update pin status', variant: 'error' })
    } finally {
      (await overseer)[Symbol.dispose]()
    }
  }

  const handleRename = async (gadget: GadgetMetadataWithTimestamps, newTitle: string) => {
    // Optimistically update
    setGadgets(prev => prev.map(g => g.id === gadget.id ? { ...g, title: newTitle } : g))
    // Use promise pipelining — call setTitle without awaiting openGadget first
    const overseer = authenticatedApi.openGadget(gadget.id)
    try {
      await overseer.setTitle(newTitle)
    } catch (err) {
      console.error('Failed to rename gadget:', err)
      setGadgets(prev => prev.map(g => g.id === gadget.id ? { ...g, title: gadget.title } : g))
      toasts.add({ title: 'Failed to rename gadget', variant: 'error' })
    } finally {
      (await overseer)[Symbol.dispose]()
    }
  }

  const handleShareClose = () => {
    setShareTarget(null)
  }

  const filtered = gadgets.filter((g) => {
    if (!search) return true
    return (g.title || '').toLowerCase().includes(search.toLowerCase())
  })

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 px-6 sm:px-10 lg:px-10 pt-10 lg:pt-10">
        <h2 className="text-lg font-semibold text-kumo-default">
          Your gadgets
        </h2>
      </div>

      {/* Search */}
      <div className="mb-4 px-6 sm:px-10 lg:px-10">
        <div className="relative">
          <MagnifyingGlass
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search gadgets..."
            className="w-full pl-9 pr-4 py-2 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:border-kumo-brand"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex flex-col gap-0.5 flex-1 min-h-0 overflow-y-auto pl-6 sm:pl-10 lg:pl-10 pr-2">
        {loading ? (
          <>
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-[56px] rounded-xl bg-kumo-elevated animate-pulse" />
            ))}
          </>
        ) : loadError ? (
          <div className="text-center py-12 text-sm">
            <p className="text-kumo-danger">Something went wrong loading your gadgets.</p>
            <button onClick={loadGadgets} className="text-kumo-brand mt-1 underline">Try again</button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-kumo-inactive text-sm">
            {search ? 'No gadgets found' : 'No gadgets yet. Create your first one!'}
          </div>
        ) : (
          filtered.map((gadget) => (
            <AppRow
              key={gadget.id}
              gadget={gadget}
              onDelete={handleDelete}
              onShare={handleShare}
              onInfo={setInfoTarget}
              onTogglePin={handleTogglePin}
              onRename={handleRename}
            />
          ))
        )}
      </div>

      {/* Delete confirmation dialog */}
      <Dialog.Root
        role="alertdialog"
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}
      >
        <Dialog className="p-8" size="sm">
          <Dialog.Title className="text-lg font-semibold">
            {deleteTarget?.owner ? 'Remove gadget' : 'Delete gadget'}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-kumo-subtle">
            {deleteTarget?.owner
              ? `Remove "${deleteTarget?.title || 'Untitled Gadget'}" from your list? You can still access it via its link.`
              : `Delete "${deleteTarget?.title || 'Untitled Gadget'}"? This cannot be undone.`}
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <Button variant="secondary" {...props} disabled={isDeleting}>
                  Cancel
                </Button>
              )}
            />
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              loading={isDeleting}
            >
              {deleteTarget?.owner ? 'Remove' : 'Delete'}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>

      {/* Information modal */}
      <Dialog.Root
        open={infoTarget !== null}
        onOpenChange={(open) => { if (!open) setInfoTarget(null) }}
      >
        <Dialog className="p-8" size="sm">
          <Dialog.Title className="text-lg font-semibold">
            {infoTarget?.title || 'Untitled Gadget'}
          </Dialog.Title>
          <div className="mt-4 flex flex-col gap-3 text-sm">
            <div className="flex justify-between">
              <span className="text-kumo-subtle">Author</span>
              <span className="text-kumo-default">{infoTarget?.owner ? infoTarget.owner.name : 'You'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-kumo-subtle">Total cost</span>
              <span className="text-kumo-default">
                {formatCost(infoTarget?.totalCost ?? 0)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-kumo-subtle">Created</span>
              <span className="text-kumo-default">
                {infoTarget?.created?.toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-kumo-subtle">Last active</span>
              <span className="text-kumo-default">
                {infoTarget?.lastActive?.toLocaleString()}
              </span>
            </div>
          </div>
          <div className="mt-6 flex justify-end">
            <Dialog.Close
              render={(props) => (
                <Button variant="secondary" {...props}>
                  Close
                </Button>
              )}
            />
          </div>
        </Dialog>
      </Dialog.Root>

      {/* Share modal */}
      {shareOverseer && shareTarget && (
        <ShareModal
          open={true}
          onClose={handleShareClose}
          overseer={shareOverseer.stub}
          metadata={shareTarget}
          currentUser={userInfo}
        />
      )}
    </div>
  )
}
