import { useState } from 'react'
import { Cube, PencilSimple, Check, X } from '@phosphor-icons/react'
import { Tooltip } from '@cloudflare/kumo'
import type { WorkpieceId, WorkpieceSummary } from '@gadgets/workshop-shared/api'
import { WorkshopIconButton, WorkshopInput } from './components/WorkshopControls'

// Sidebar listing the workspace's gadget workpieces, shown as the leftmost column of the editor's
// right panel when the workspace has more than one gadget to pick from. Selection is owned by the
// parent (it lives in the URL's `?w=` search param).
interface WorkpiecePickerProps {
  // Gadget-type workpieces to display, already filtered to those visible in the current context
  // (pending gadgets are only listed while their chat is open).
  gadgets: WorkpieceSummary[]
  selectedId: WorkpieceId | null
  // The gadget the agent is currently streaming edits into, if any. Shown as an activity dot when
  // it isn't the selected one (e.g. because the user pinned their selection mid-turn).
  agentEditingId?: WorkpieceId | null
  // Height of the empty header spacer above the list, matching the adjacent panes' top bars so
  // chrome that aligns to them (e.g. the agent-activity progress line) meets a bar edge here
  // instead of slicing through the first row.
  headerHeight: number
  onSelect: (id: WorkpieceId) => void
  onRename: (id: WorkpieceId, title: string) => void
}

export default function WorkpiecePicker({
  gadgets,
  selectedId,
  agentEditingId,
  headerHeight,
  onSelect,
  onRename,
}: WorkpiecePickerProps) {
  const [editing, setEditing] = useState<{ id: WorkpieceId; value: string } | null>(null)

  const commitRename = () => {
    if (!editing) return
    const title = editing.value.trim()
    if (title) onRename(editing.id, title)
    setEditing(null)
  }

  return (
    <div className="flex w-48 flex-shrink-0 flex-col border-r border-kumo-line bg-kumo-base">
      <div
        className="flex-shrink-0 border-b border-kumo-line"
        style={{ height: headerHeight }}
      />
      <div className="flex-1 overflow-y-auto py-2">
      {gadgets.map(gadget => {
        const isSelected = gadget.id === selectedId
        const isPending = gadget.chatId !== undefined
        const isAgentEditing = agentEditingId === gadget.id && !isSelected

        if (editing?.id === gadget.id) {
          return (
            <div key={gadget.id} className="flex items-center gap-1 px-2 py-0.5">
              <WorkshopInput
                type="text"
                value={editing.value}
                onChange={e => setEditing({ id: gadget.id, value: e.target.value })}
                onKeyDown={e => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setEditing(null)
                }}
                autoFocus
                className="!h-7 min-w-0 flex-1 bg-kumo-tint text-[13px]"
              />
              <WorkshopIconButton
                onClick={commitRename}
                disabled={!editing.value.trim()}
                className="!h-6 !w-6"
                aria-label="Save gadget name"
              >
                <Check size={13} />
              </WorkshopIconButton>
              <WorkshopIconButton
                onClick={() => setEditing(null)}
                className="!h-6 !w-6"
                aria-label="Cancel rename"
              >
                <X size={13} />
              </WorkshopIconButton>
            </div>
          )
        }

        return (
          <div
            key={gadget.id}
            className={`group/workpiece mx-2 flex items-center gap-2 rounded-lg px-2 py-1.5 ${
              isSelected ? 'bg-kumo-tint text-kumo-default' : 'text-kumo-subtle hover:bg-kumo-tint/60 hover:text-kumo-default'
            }`}
          >
            <button
              type="button"
              onClick={() => onSelect(gadget.id)}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
              aria-current={isSelected ? 'true' : undefined}
            >
              <Cube size={15} className="flex-shrink-0" weight={isSelected ? 'fill' : 'regular'} />
              <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] tracking-[-0.25px]">
                {gadget.title}
              </span>
              {isAgentEditing && (
                <Tooltip content="The agent is editing this gadget" asChild>
                  <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-kumo-brand" />
                </Tooltip>
              )}
              {isPending && (
                <Tooltip content="Created in this chat; kept when you accept the chat's changes" asChild>
                  <span className="flex-shrink-0 rounded-full bg-kumo-fill px-1.5 py-0.5 text-[10px] leading-none font-medium text-kumo-subtle">
                    Draft
                  </span>
                </Tooltip>
              )}
            </button>
            <WorkshopIconButton
              onClick={() => setEditing({ id: gadget.id, value: gadget.title })}
              className="!h-6 !w-6 flex-shrink-0 opacity-0 transition-opacity duration-150 ease-out group-hover/workpiece:opacity-100 focus-visible:opacity-100"
              title="Rename gadget"
              aria-label={`Rename ${gadget.title}`}
            >
              <PencilSimple size={13} />
            </WorkshopIconButton>
          </div>
        )
      })}
      </div>
    </div>
  )
}
