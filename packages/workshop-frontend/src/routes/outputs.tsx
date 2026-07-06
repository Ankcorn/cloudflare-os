import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { DropdownMenu, useKumoToastManager } from '@cloudflare/kumo'
import {
  FileText,
  GridNine,
  Presentation,
  AppWindow,
  MagnifyingGlass,
  DotsThreeVertical,
  Stack,
  ArrowSquareOut,
  Pencil,
  DownloadSimple,
  Trash,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react'
import { useDocumentTitle } from '../useDocumentTitle'
import ViewToggle from '../components/ViewToggle'
import ComingSoonPreview from '../components/ComingSoonPreview'
import { MENU_CONTENT, MENU_ITEM, MENU_ITEM_DANGER } from '../components/menuStyles'

// NOTE: This is a design mock. The data below is placeholder; wiring outputs to real workspace
// artifacts comes later. The goal here is to lock in the look/feel: a Google-Docs-style gallery
// (grid) plus a dense list, type filters, and search — all in the app's design language.

export const Route = createFileRoute('/outputs')({
  component: OutputsPage,
})

type OutputType = 'document' | 'spreadsheet' | 'presentation' | 'app'

interface OutputItem {
  id: string
  title: string
  type: OutputType
  workspace: string
  updated: string
}

const TYPE_META: Record<OutputType, { label: string; plural: string; Icon: PhosphorIcon }> = {
  document: { label: 'Document', plural: 'Documents', Icon: FileText },
  spreadsheet: { label: 'Spreadsheet', plural: 'Spreadsheets', Icon: GridNine },
  presentation: { label: 'Presentation', plural: 'Presentations', Icon: Presentation },
  app: { label: 'App', plural: 'Apps', Icon: AppWindow },
}

const MOCK_OUTPUTS: OutputItem[] = [
  { id: '1', title: 'Q3 Revenue Analysis', type: 'spreadsheet', workspace: 'Finance Copilot', updated: '2h ago' },
  { id: '2', title: 'Team Offsite Agenda', type: 'document', workspace: 'Planning', updated: 'Yesterday' },
  { id: '3', title: 'Product Launch Deck', type: 'presentation', workspace: 'GTM Assistant', updated: '3d ago' },
  { id: '4', title: 'Expense Tracker', type: 'app', workspace: 'Personal Finance', updated: '5d ago' },
  { id: '5', title: 'Customer Interview Notes', type: 'document', workspace: 'Research', updated: '1w ago' },
  { id: '6', title: 'Hiring Pipeline', type: 'spreadsheet', workspace: 'Recruiting', updated: '1w ago' },
  { id: '7', title: 'Sales Dashboard', type: 'app', workspace: 'Revenue Ops', updated: '2w ago' },
  { id: '8', title: 'Onboarding Guide', type: 'document', workspace: 'People Ops', updated: '2w ago' },
  { id: '9', title: 'Roadmap Review', type: 'presentation', workspace: 'Product', updated: '3w ago' },
  { id: '10', title: 'Marketing Budget', type: 'spreadsheet', workspace: 'Finance Copilot', updated: '1mo ago' },
]

// ─── faux thumbnail previews ─────────────────────────────────────────────────

const BAR = 'rounded-[2px] bg-kumo-line'
const BAR_STRONG = 'rounded-[2px] bg-kumo-fill'

function DocumentPreview() {
  return (
    <div className="flex h-full flex-col gap-[6px]">
      <div className={`h-2 w-1/2 ${BAR_STRONG}`} />
      <div className="mt-1 flex flex-col gap-[5px]">
        <div className={`h-1.5 w-full ${BAR}`} />
        <div className={`h-1.5 w-[94%] ${BAR}`} />
        <div className={`h-1.5 w-full ${BAR}`} />
        <div className={`h-1.5 w-[72%] ${BAR}`} />
      </div>
      <div className="mt-1.5 flex flex-col gap-[5px]">
        <div className={`h-1.5 w-full ${BAR}`} />
        <div className={`h-1.5 w-[88%] ${BAR}`} />
        <div className={`h-1.5 w-[60%] ${BAR}`} />
      </div>
    </div>
  )
}

function SpreadsheetPreview() {
  return (
    <div className="flex h-full flex-col gap-px overflow-hidden rounded-[3px] bg-kumo-line">
      {Array.from({ length: 6 }).map((_, r) => (
        <div key={r} className="grid flex-1 grid-cols-4 gap-px">
          {Array.from({ length: 4 }).map((__, c) => (
            <div key={c} className={r === 0 || c === 0 ? 'bg-kumo-fill' : 'bg-kumo-base'} />
          ))}
        </div>
      ))}
    </div>
  )
}

function PresentationPreview() {
  return (
    <div className="flex h-full flex-col gap-2">
      <div className={`h-2.5 w-2/3 ${BAR_STRONG}`} />
      <div className="flex flex-1 gap-2">
        <div className={`h-full flex-1 ${BAR}`} />
        <div className="flex flex-1 flex-col justify-center gap-[6px]">
          <div className={`h-1.5 w-full ${BAR}`} />
          <div className={`h-1.5 w-[85%] ${BAR}`} />
          <div className={`h-1.5 w-[70%] ${BAR}`} />
          <div className={`h-1.5 w-[80%] ${BAR}`} />
        </div>
      </div>
    </div>
  )
}

function AppPreview() {
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-kumo-line" />
        <span className="h-1.5 w-1.5 rounded-full bg-kumo-line" />
        <span className="h-1.5 w-1.5 rounded-full bg-kumo-line" />
        <div className={`ml-1 h-1.5 flex-1 ${BAR}`} />
      </div>
      <div className="flex flex-1 gap-2">
        <div className="flex w-1/4 flex-col gap-1.5">
          <div className={`h-1.5 w-full ${BAR}`} />
          <div className={`h-1.5 w-3/4 ${BAR}`} />
          <div className={`h-1.5 w-full ${BAR}`} />
          <div className={`h-1.5 w-2/3 ${BAR}`} />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="h-5 rounded-[3px] bg-kumo-tint" />
            <div className="h-5 rounded-[3px] bg-kumo-tint" />
          </div>
          <div className="flex flex-1 items-end gap-1.5">
            {[55, 80, 40, 95, 65, 75].map((h, i) => (
              <div key={i} className={`flex-1 ${BAR_STRONG}`} style={{ height: `${h}%` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function OutputThumbnail({ type }: { type: OutputType }) {
  return (
    <div className="absolute inset-0 bg-kumo-tint">
      {/* The "page" floats like a Google-Docs preview, bleeding off the bottom edge. */}
      <div className="themed-thumbnail-shadow absolute left-1/2 top-4 h-[calc(100%-1rem)] w-[78%] -translate-x-1/2 overflow-hidden rounded-t-[6px] bg-kumo-base ring-1 ring-kumo-line/20">
        <div className="h-full w-full p-3.5">
          {type === 'document' && <DocumentPreview />}
          {type === 'spreadsheet' && <SpreadsheetPreview />}
          {type === 'presentation' && <PresentationPreview />}
          {type === 'app' && <AppPreview />}
        </div>
      </div>
    </div>
  )
}

// ─── rows / cards ────────────────────────────────────────────────────────────

function TypeTile({ type, size = 'md' }: { type: OutputType; size?: 'sm' | 'md' }) {
  const { Icon } = TYPE_META[type]
  const dim = size === 'sm' ? 'h-7 w-7' : 'h-9 w-9'
  return (
    <div className={`flex ${dim} shrink-0 items-center justify-center rounded-lg bg-kumo-fill text-kumo-subtle`}>
      <Icon size={size === 'sm' ? 14 : 16} />
    </div>
  )
}

function OutputMenu({ onAction }: { onAction: () => void }) {
  return (
    <div onClick={(e) => { e.stopPropagation() }}>
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <button
              type="button"
              aria-label="Output actions"
              className="cursor-pointer rounded-md p-1.5 text-kumo-subtle transition-colors hover:bg-kumo-fill hover:text-kumo-default focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
            >
              <DotsThreeVertical size={16} />
            </button>
          }
        />
        <DropdownMenu.Content className={MENU_CONTENT}>
          <DropdownMenu.Item onClick={onAction} className={MENU_ITEM}>
            <ArrowSquareOut size={13} className="mr-2" /> Open
          </DropdownMenu.Item>
          <DropdownMenu.Item onClick={onAction} className={MENU_ITEM}>
            <Pencil size={13} className="mr-2" /> Rename
          </DropdownMenu.Item>
          <DropdownMenu.Item onClick={onAction} className={MENU_ITEM}>
            <DownloadSimple size={13} className="mr-2" /> Download
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item variant="danger" onClick={onAction} className={MENU_ITEM_DANGER}>
            <Trash size={13} className="mr-2" /> Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
    </div>
  )
}

function OutputCard({ item, onOpen }: { item: OutputItem; onOpen: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className="press group flex cursor-pointer flex-col overflow-hidden rounded-xl border border-kumo-line bg-kumo-base text-left transition-[border-color,box-shadow] duration-150 ease-out hover:border-kumo-fill hover:shadow-[0_8px_22px_-16px_rgba(20,17,16,0.16)]"
    >
      <div className="relative aspect-[4/3] w-full border-b border-kumo-line">
        <OutputThumbnail type={item.type} />
      </div>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <TypeTile type={item.type} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default">
            {item.title}
          </p>
          <p className="mt-0.5 truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
            {item.workspace} · {item.updated}
          </p>
        </div>
        <OutputMenu onAction={onOpen} />
      </div>
    </div>
  )
}

function OutputRow({ item, onOpen }: { item: OutputItem; onOpen: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      className="group flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 ease-out hover:bg-kumo-tint"
    >
      <TypeTile type={item.type} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">{item.title}</p>
        <p className="mt-0.5 truncate text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
          {TYPE_META[item.type].label} · {item.workspace}
        </p>
      </div>
      <span className="hidden shrink-0 text-xs tracking-[-0.1px] text-kumo-inactive lg:block">
        {item.updated}
      </span>
      <OutputMenu onAction={onOpen} />
    </div>
  )
}

// ─── filter chips ────────────────────────────────────────────────────────────

function FilterChip({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium tracking-[-0.25px] transition-colors ${
        active
          ? 'bg-kumo-fill text-kumo-strong'
          : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'
      }`}
    >
      {label}
      <span className={active ? 'text-kumo-subtle' : 'text-kumo-inactive'}>{count}</span>
    </button>
  )
}

// ─── page ─────────────────────────────────────────────────────────────────────

type Filter = 'all' | OutputType

function OutputsPage() {
  useDocumentTitle('Outputs')
  const toasts = useKumoToastManager()

  const [view, setView] = useState<'grid' | 'list'>(() => {
    if (typeof window === 'undefined') return 'grid'
    return localStorage.getItem('outputs-view') === 'list' ? 'list' : 'grid'
  })
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')

  useEffect(() => {
    localStorage.setItem('outputs-view', view)
  }, [view])

  const openSoon = () => toasts.add({ title: 'Output preview coming soon' })

  const counts = {
    all: MOCK_OUTPUTS.length,
    document: MOCK_OUTPUTS.filter((o) => o.type === 'document').length,
    spreadsheet: MOCK_OUTPUTS.filter((o) => o.type === 'spreadsheet').length,
    presentation: MOCK_OUTPUTS.filter((o) => o.type === 'presentation').length,
    app: MOCK_OUTPUTS.filter((o) => o.type === 'app').length,
  }

  const q = search.trim().toLowerCase()
  const filtered = MOCK_OUTPUTS.filter((o) => {
    if (filter !== 'all' && o.type !== filter) return false
    if (q && !o.title.toLowerCase().includes(q) && !o.workspace.toLowerCase().includes(q)) return false
    return true
  })

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-6 sm:px-10">
      <header className="flex items-end justify-between gap-4 px-3 pb-4 pt-10">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Outputs</h1>
          <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
            Documents, spreadsheets, presentations, and apps your workspaces produce.
          </p>
        </div>
        <ViewToggle view={view} onChange={setView} />
      </header>

      {/* The section below is a non-functional preview, frosted out behind a "coming soon" overlay.
          The header + view toggle above stay live. */}
      <ComingSoonPreview
        icon={Stack}
        title="Outputs are coming soon to Gadgets"
        description="A preview of how the documents, spreadsheets, presentations, and apps your workspaces produce will show up here."
      >
      {/* Toolbar: type filters + search */}
      <div className="flex flex-col gap-3 px-3 pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 sidebar-scroll">
          <FilterChip active={filter === 'all'} label="All" count={counts.all} onClick={() => setFilter('all')} />
          <FilterChip active={filter === 'document'} label="Documents" count={counts.document} onClick={() => setFilter('document')} />
          <FilterChip active={filter === 'spreadsheet'} label="Spreadsheets" count={counts.spreadsheet} onClick={() => setFilter('spreadsheet')} />
          <FilterChip active={filter === 'presentation'} label="Presentations" count={counts.presentation} onClick={() => setFilter('presentation')} />
          <FilterChip active={filter === 'app'} label="Apps" count={counts.app} onClick={() => setFilter('app')} />
        </div>
        <div className="relative sm:w-64">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search outputs…"
            className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base pl-9 pr-4 text-[13px] tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] duration-150 ease-out focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15"
          />
        </div>
      </div>

      <div className="chat-panel min-h-0 flex-1 overflow-y-auto pb-8 pt-1">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-3 py-20 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-kumo-fill text-kumo-subtle">
              <Stack size={18} />
            </div>
            <div>
              <p className="text-sm font-medium text-kumo-default">
                {search || filter !== 'all' ? 'No outputs match' : 'No outputs yet'}
              </p>
              <p className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">
                {search || filter !== 'all'
                  ? 'Try a different filter or search term.'
                  : 'Outputs created by your workspaces will show up here.'}
              </p>
            </div>
          </div>
        ) : view === 'grid' ? (
          <div className="grid grid-cols-2 gap-4 px-3 sm:grid-cols-3 lg:grid-cols-4">
            {filtered.map((item) => (
              <OutputCard key={item.id} item={item} onOpen={openSoon} />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((item) => (
              <OutputRow key={item.id} item={item} onOpen={openSoon} />
            ))}
          </div>
        )}
      </div>
      </ComingSoonPreview>
    </div>
  )
}
