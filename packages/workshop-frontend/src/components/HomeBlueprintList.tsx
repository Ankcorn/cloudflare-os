import { Link } from '@tanstack/react-router'
import { ArrowRight, Blueprint, DotsThreeVertical, Hexagon, MagnifyingGlass, PushPin, UploadSimple } from '@phosphor-icons/react'
import { DropdownMenu, Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { BlueprintLibrarySummary, BlueprintMetadata, BlueprintUserSummary } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'
import { getGradient } from './BlueprintCard'

type HomeBlueprintItem = {
  id: string
  title: string
  description: string
  metadata?: BlueprintMetadata
  published?: BlueprintUserSummary
  uploaded?: boolean
  addedAt?: Date
  lastUpdated?: Date
  pinned?: boolean
}

export default function HomeBlueprintList() {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const mountedRef = useRef(false)
  const loadRequestRef = useRef(0)

  const [myBlueprints, setMyBlueprints] = useState<BlueprintUserSummary[]>([])
  const [libraryBlueprints, setLibraryBlueprints] = useState<BlueprintLibrarySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [search, setSearch] = useState('')

  const loadBlueprints = useCallback(async () => {
    const requestId = ++loadRequestRef.current
    setLoading(true)
    setLoadError(false)

    try {
      const [mine, library] = await Promise.all([
        authenticatedApi.listOwnBlueprints(),
        authenticatedApi.listLibraryBlueprints(),
      ])
      if (!mountedRef.current || loadRequestRef.current !== requestId) return
      setMyBlueprints(mine)
      setLibraryBlueprints(library)
      setLoading(false)
    } catch (err) {
      console.error('Failed to load home blueprints:', err)
      if (mountedRef.current && loadRequestRef.current === requestId) {
        setLoading(false)
        setLoadError(true)
      }
    }
  }, [authenticatedApi])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      loadRequestRef.current++
    }
  }, [])

  useEffect(() => {
    void loadBlueprints()
  }, [loadBlueprints])

  const blueprints = useMemo(() => {
    const items = new Map<string, HomeBlueprintItem>()

    const ensureItem = (id: string) => {
      let item = items.get(id)
      if (item) return item
      item = {
        id,
        title: 'Untitled blueprint',
        description: '',
      }
      items.set(id, item)
      return item
    }

    for (const blueprint of libraryBlueprints) {
      const item = ensureItem(blueprint.id)
      item.metadata = blueprint.metadata
      item.title = blueprint.metadata.title
      item.description = blueprint.metadata.description
      item.uploaded = blueprint.uploaded
      item.addedAt = blueprint.addedAt
      item.pinned ||= blueprint.pinned === true
    }

    for (const blueprint of myBlueprints) {
      const item = ensureItem(blueprint.id)
      item.published = blueprint
      item.title = blueprint.title
      item.description = blueprint.description
      item.lastUpdated = blueprint.lastUpdated
      item.pinned ||= blueprint.pinned === true
    }

    return Array.from(items.values()).sort((a, b) => {
      if (a.pinned && !b.pinned) return -1
      if (!a.pinned && b.pinned) return 1
      const aTime = (a.lastUpdated ?? a.addedAt ?? new Date(0)).valueOf()
      const bTime = (b.lastUpdated ?? b.addedAt ?? new Date(0)).valueOf()
      return bTime - aTime
    })
  }, [libraryBlueprints, myBlueprints])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return blueprints
    return blueprints.filter((blueprint) => {
      const text = [
        blueprint.title,
        blueprint.description,
        blueprint.published?.gadgetTitle,
      ].join(' ').toLowerCase()
      return text.includes(query)
    })
  }, [blueprints, search])

  const handleBlueprintSelected = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setUploading(true)
    try {
      await authenticatedApi.importBlueprint(file.stream() as ReadableStream<Uint8Array>)
      toasts.add({ title: 'Blueprint uploaded', variant: 'success' })
      await loadBlueprints()
    } catch (err) {
      console.error('Failed to upload blueprint:', err)
      toasts.add({ title: 'Failed to upload blueprint', variant: 'error' })
    } finally {
      setUploading(false)
    }
  }, [authenticatedApi, loadBlueprints, toasts])

  const removeFromLibrary = useCallback(async (blueprint: HomeBlueprintItem) => {
    if (!blueprint.metadata) return
    try {
      await authenticatedApi.removeBlueprintFromLibrary(blueprint.id)
      setLibraryBlueprints((prev) => prev.filter((item) => item.id !== blueprint.id))
      if (!blueprint.published) {
        setMyBlueprints((prev) => prev.filter((item) => item.id !== blueprint.id))
      }
      toasts.add({ title: blueprint.uploaded ? 'Blueprint deleted' : 'Blueprint removed from library', variant: 'success' })
    } catch (err) {
      console.error('Failed to remove blueprint from library:', err)
      toasts.add({ title: blueprint.uploaded ? 'Failed to delete blueprint' : 'Failed to remove blueprint from library', variant: 'error' })
    }
  }, [authenticatedApi, toasts])

  const togglePin = useCallback(async (blueprint: HomeBlueprintItem) => {
    const nextPinned = !blueprint.pinned

    if (blueprint.published) {
      setMyBlueprints((prev) => prev.map((item) => item.id === blueprint.id ? { ...item, pinned: nextPinned } : item))
    }
    if (blueprint.metadata) {
      setLibraryBlueprints((prev) => prev.map((item) => item.id === blueprint.id ? { ...item, pinned: nextPinned } : item))
    }

    try {
      await authenticatedApi.setBlueprintPinned(blueprint.id, nextPinned)
    } catch (err) {
      console.error('Failed to update blueprint pin:', err)
      toasts.add({ title: 'Failed to update pin status', variant: 'error' })
      void loadBlueprints()
    }
  }, [authenticatedApi, loadBlueprints, toasts])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <input
        ref={uploadInputRef}
        type="file"
        accept=".gadget"
        className="hidden"
        onChange={handleBlueprintSelected}
      />

      {!loading && blueprints.length > 0 && (
        <div className="mb-4 px-6 sm:px-10 lg:px-10">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <MagnifyingGlass
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive"
              />
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search blueprints..."
                className="h-9 w-full rounded-xl border border-kumo-line bg-kumo-base/70 pl-9 pr-4 text-sm text-kumo-default placeholder:text-kumo-inactive transition-[background-color,border-color,box-shadow] duration-150 ease-out focus:border-kumo-brand focus:bg-kumo-base focus:outline-none focus:ring-[3px] focus:ring-black/5"
              />
            </div>
            <Tooltip
              content="Upload a .gadget archive"
              render={(
                <button
                  type="button"
                  onClick={() => uploadInputRef.current?.click()}
                  disabled={uploading}
                  className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border border-kumo-line bg-kumo-base/60 px-2.5 text-[12px] font-medium tracking-[-0.2px] text-kumo-subtle transition-[background-color,border-color,color,opacity,transform,box-shadow] duration-150 ease-out hover:border-kumo-fill hover:bg-kumo-base hover:text-kumo-default hover:shadow-[0_1px_2px_rgba(0,0,0,0.035)] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <UploadSimple size={13} weight="bold" />
                  <span className="hidden sm:inline">{uploading ? 'Uploading...' : 'Upload'}</span>
                </button>
              )}
            />
          </div>
        </div>
      )}

      <div className="chat-panel flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pl-6 pr-2 pt-1 sm:pl-10 lg:pl-10">
        {loading ? (
          [1, 2, 3].map((i) => (
            <div key={i} className="mr-4 h-[76px] animate-pulse rounded-xl bg-kumo-base sm:mr-6" />
          ))
        ) : loadError ? (
          <div className="py-12 pr-4 text-center text-sm sm:pr-6">
            <p className="text-kumo-danger">Something went wrong loading your blueprints.</p>
            <button onClick={loadBlueprints} className="mt-1 text-kumo-brand underline">Try again</button>
          </div>
        ) : filtered.length === 0 ? (
          search ? (
            <div className="py-12 pr-4 text-center text-sm text-kumo-inactive sm:pr-6">
              No blueprints found
            </div>
          ) : (
            <EmptyBlueprints onUpload={() => uploadInputRef.current?.click()} uploading={uploading} />
          )
        ) : (
          filtered.map((blueprint) => (
            <BlueprintRow
              key={blueprint.id}
              blueprint={blueprint}
              onTogglePin={() => togglePin(blueprint)}
              onRemoveFromLibrary={blueprint.metadata ? () => removeFromLibrary(blueprint) : undefined}
            />
          ))
        )}
      </div>
    </div>
  )
}

function BlueprintRow({
  blueprint,
  onTogglePin,
  onRemoveFromLibrary,
}: {
  blueprint: HomeBlueprintItem
  onTogglePin: () => void
  onRemoveFromLibrary?: () => void
}) {
  const meta = blueprint.published
    ? `From ${blueprint.published.gadgetTitle}`
    : `by ${blueprint.metadata?.author.name ?? 'Unknown author'}`

  return (
    <Link
      to="/blueprint/$id"
      params={{ id: blueprint.id }}
      className="group mr-4 flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 transition-[background-color,border-color,box-shadow,transform] duration-150 ease-out hover:border-kumo-line hover:bg-kumo-base hover:shadow-[0_8px_20px_-18px_rgba(82,16,0,0.28)] active:scale-[0.995] sm:mr-6"
    >
      <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br ${getGradient(blueprint.id)}`}>
        <Hexagon size={14} className="text-white/70" weight="bold" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {blueprint.pinned && <PushPin size={12} weight="fill" className="shrink-0 text-kumo-brand" />}
          <h3 className="truncate text-sm font-medium text-kumo-default">
            {blueprint.title || 'Untitled blueprint'}
          </h3>
        </div>
        <p className="mt-0.5 truncate text-xs text-kumo-subtle">
          {meta}
        </p>
      </div>

      <div className="flex items-center gap-1" onClick={(event) => { event.preventDefault(); event.stopPropagation() }}>
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <button className="rounded-md p-1.5 text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100">
                <DotsThreeVertical size={16} />
              </button>
            }
          />
          <DropdownMenu.Content>
            <DropdownMenu.Item onClick={onTogglePin}>
              <PushPin size={14} className="mr-2" weight={blueprint.pinned ? 'fill' : 'regular'} />
              {blueprint.pinned ? 'Unpin' : 'Pin to top'}
            </DropdownMenu.Item>
            {onRemoveFromLibrary && (
              <>
                <DropdownMenu.Separator />
                <DropdownMenu.Item
                  variant="danger"
                  onClick={onRemoveFromLibrary}
                >
                  {blueprint.uploaded ? 'Delete blueprint' : 'Remove from library'}
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu>

      </div>
    </Link>
  )
}

function EmptyBlueprints({ onUpload, uploading }: { onUpload: () => void; uploading: boolean }) {
  return (
    <div className="mr-4 rounded-2xl border border-dashed border-kumo-line bg-kumo-base px-4 py-8 text-center sm:mr-6">
      <div className="mx-auto grid h-10 w-10 place-items-center rounded-2xl bg-kumo-tint text-kumo-subtle">
        <Blueprint size={20} weight="regular" />
      </div>
      <p className="mt-3 text-[13px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default">
        No blueprints yet
      </p>
      <p className="mx-auto mt-1 max-w-[320px] text-[12px] font-normal leading-4 tracking-[-0.2px] text-kumo-subtle">
        Save blueprints from Explore or create one from a Gadget. Pinned blueprints will stay at the top.
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <Link
          to="/explore"
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-kumo-line bg-kumo-base px-3 text-[12px] font-medium text-kumo-default transition-[background-color,border-color,transform] duration-150 ease-out hover:border-kumo-fill hover:bg-kumo-tint active:scale-[0.98]"
        >
          Explore blueprints
          <ArrowRight size={12} weight="bold" />
        </Link>
        <button
          type="button"
          onClick={onUpload}
          disabled={uploading}
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-kumo-line bg-kumo-base px-3 text-[12px] font-medium text-kumo-default transition-[background-color,border-color,opacity,transform] duration-150 ease-out hover:border-kumo-fill hover:bg-kumo-tint active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <UploadSimple size={12} weight="bold" />
          {uploading ? 'Uploading...' : 'Upload .gadget'}
        </button>
      </div>
    </div>
  )
}
