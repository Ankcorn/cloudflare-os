import { useMemo, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { CaretRight, Pulse } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { EmptyState } from './components/EmptyState'
import { GatekeeperIcon } from './components/GatekeeperIcon'
import { WorkshopButton, WorkshopIconButton } from './components/WorkshopControls'
import { useActions } from './useActions'

function getSafeExternalUrl(url: string | undefined): string | undefined {
  if (!url) return undefined

  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

const formatDate = (date: Date) => new Date(date).toLocaleString()

const formatTime = (date: Date) => new Date(date).toLocaleTimeString([], {
  hour: 'numeric',
  minute: '2-digit',
})

interface ActivityProps {
  overseer: RpcStub<Overseer>
}

export default function Activity({ overseer }: ActivityProps) {
  const { actionsById, isReady } = useActions(overseer)
  const [processingActions, setProcessingActions] = useState<Set<number>>(new Set())
  const [expandedActionId, setExpandedActionId] = useState<number | null>(null)
  const toasts = useKumoToastManager()

  const handleApproveAction = async (actionId: number) => {
    setProcessingActions(prev => new Set(prev).add(actionId))
    try {
      await overseer.approveAction(actionId)
    } catch (err) {
      console.error('Failed to approve action:', err)
      toasts.add({ title: 'Failed to approve action', variant: 'error' })
    } finally {
      setProcessingActions(prev => {
        const next = new Set(prev)
        next.delete(actionId)
        return next
      })
    }
  }

  const handleRejectAction = async (actionId: number) => {
    setProcessingActions(prev => new Set(prev).add(actionId))
    try {
      await overseer.rejectAction(actionId)
    } catch (err) {
      console.error('Failed to reject action:', err)
      toasts.add({ title: 'Failed to reject action', variant: 'error' })
    } finally {
      setProcessingActions(prev => {
        const next = new Set(prev)
        next.delete(actionId)
        return next
      })
    }
  }

  const toggleExpanded = (id: number) => {
    setExpandedActionId(prev => prev === id ? null : id)
  }

  const { pendingActions, historyActions } = useMemo(() => {
    const sortedActions = [...actionsById.values()].sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    )

    return {
      pendingActions: sortedActions.filter(record => record.state === 'pending'),
      historyActions: sortedActions.filter(record => record.state !== 'pending'),
    }
  }, [actionsById])
  const hasAnyActivity = pendingActions.length > 0 || historyActions.length > 0

  return (
    <div className="h-full overflow-auto bg-kumo-base">
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-4 py-5 sm:px-6">
        <section className="flex-1">
          <div className="mb-3 flex min-h-9 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h2 className="m-0 text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                Activity
              </h2>
              <p className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                Approve resource requests and inspect this gadget's connection history.
              </p>
            </div>
          </div>

          {!isReady ? (
            <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-6 text-center text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
              Loading activity...
            </div>
          ) : !hasAnyActivity ? (
            <EmptyState
              title="No activity yet"
              description="Actions will appear here when this gadget interacts with connected resources."
              icon={Pulse}
            />
          ) : (
            <div className="space-y-6">
              {pendingActions.length > 0 && (
                <section>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h4 className="m-0 text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                      Needs approval
                    </h4>
                    <span className="text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                      {pendingActions.length} pending
                    </span>
                  </div>
                  <div className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
                    {pendingActions.map((record, index) => (
                      <ActionRow
                        key={record.id}
                        record={record}
                        isProcessing={processingActions.has(record.id)}
                        isExpanded={expandedActionId === record.id}
                        isFirst={index === 0}
                        showApprovalActions
                        onToggleExpand={() => toggleExpanded(record.id)}
                        onApprove={() => handleApproveAction(record.id)}
                        onReject={() => handleRejectAction(record.id)}
                        formatTime={formatTime}
                      />
                    ))}
                  </div>
                </section>
              )}

              <section>
                {historyActions.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-kumo-line bg-kumo-base px-4 py-8 text-center">
                    <p className="m-0 text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                      No history yet
                    </p>
                    <p className="mx-auto mt-1 max-w-sm text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
                      Approved and rejected actions will appear here.
                    </p>
                  </div>
                ) : (
                  <ActivityLogTable
                    actions={historyActions}
                    expandedActionId={expandedActionId}
                    onToggleExpand={toggleExpanded}
                    formatDate={formatDate}
                  />
                )}
              </section>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function ActionRow({
  record,
  isProcessing,
  isExpanded,
  isFirst,
  showApprovalActions,
  onToggleExpand,
  onApprove,
  onReject,
  formatTime,
}: {
  record: ActionLogEntry
  isProcessing: boolean
  isExpanded: boolean
  isFirst: boolean
  showApprovalActions: boolean
  onToggleExpand: () => void
  onApprove: () => void
  onReject: () => void
  formatTime: (date: Date) => string
}) {
  const safeResourceUrl = getSafeExternalUrl(record.resourceUrl)
  const statusLabel = record.state === 'pending'
    ? 'Needs approval'
    : record.state === 'approved'
      ? 'Approved'
      : 'Rejected'

  return (
    <div className={isFirst ? '' : 'border-t border-kumo-line'}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <WorkshopIconButton
          onClick={onToggleExpand}
          className="!h-7 !w-7"
          aria-label={isExpanded ? 'Collapse action details' : 'Expand action details'}
        >
          <CaretRight
            size={14}
            className={`transition-transform duration-150 ease-out ${isExpanded ? 'rotate-90' : ''}`}
          />
        </WorkshopIconButton>

        <div className="min-w-0 flex-1">
          <p className="m-0 truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
            {record.description.title}
          </p>
          <p className="mt-0.5 truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
            {safeResourceUrl ? (
              <a href={safeResourceUrl} target="_blank" rel="noopener noreferrer" className="text-kumo-default hover:underline">
                {record.resourceTitle}
              </a>
            ) : (
              record.resourceTitle
            )}
            {record.bindingName && (
              <>
                {' '}
                <span className="text-kumo-inactive">·</span>{' '}
                <span className="font-mono">{record.bindingName}</span>
              </>
            )}
            {' '}
            <span className="text-kumo-inactive">·</span>{' '}
            {formatTime(record.createdAt)}
          </p>
        </div>

        {showApprovalActions ? (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <WorkshopButton
              className="!h-9"
              onClick={onReject}
              disabled={isProcessing}
            >
              Reject
            </WorkshopButton>
            <WorkshopButton
              tone="primary"
              onClick={onApprove}
              disabled={isProcessing}
            >
              Approve
            </WorkshopButton>
          </div>
        ) : (
          <StatusPill state={record.state} label={statusLabel} />
        )}
      </div>

      {isExpanded && (
        <div className="px-3 pb-3 pl-[48px]">
          <div className="rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-2.5">
            <p className="m-0 whitespace-pre-wrap text-[12px] leading-[18px] font-normal tracking-[-0.2px] text-kumo-subtle">
              {record.description.description}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function ActivityLogTable({
  actions,
  expandedActionId,
  onToggleExpand,
  formatDate,
}: {
  actions: ActionLogEntry[]
  expandedActionId: number | null
  onToggleExpand: (id: number) => void
  formatDate: (date: Date) => string
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-kumo-line bg-kumo-base">
      <div className="min-w-[820px]">
        <div className="grid grid-cols-[40px_150px_minmax(180px,1fr)_minmax(280px,2fr)_104px] border-b border-kumo-line bg-kumo-elevated/40 px-3 py-2 text-[11px] leading-4 font-medium uppercase tracking-[0.04em] text-kumo-subtle">
          <div />
          <div>Time</div>
          <div>Source</div>
          <div>Event</div>
          <div>Result</div>
        </div>
        {actions.map((record, index) => (
          <ActivityLogRow
            key={record.id}
            record={record}
            isExpanded={expandedActionId === record.id}
            isFirst={index === 0}
            onToggleExpand={() => onToggleExpand(record.id)}
            formatDate={formatDate}
          />
        ))}
      </div>
    </div>
  )
}

function ActivityLogRow({
  record,
  isExpanded,
  isFirst,
  onToggleExpand,
  formatDate,
}: {
  record: ActionLogEntry
  isExpanded: boolean
  isFirst: boolean
  onToggleExpand: () => void
  formatDate: (date: Date) => string
}) {
  const statusLabel = record.state === 'approved' ? 'Approved' : 'Rejected'
  const safeResourceUrl = getSafeExternalUrl(record.resourceUrl)
  const created = new Date(record.createdAt)
  const createdDate = created.toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' })
  const createdTime = created.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })

  return (
    <div className={isFirst ? '' : 'border-t border-kumo-line'}>
      <div className="grid grid-cols-[40px_150px_minmax(180px,1fr)_minmax(280px,2fr)_104px] items-start px-3 py-2.5 text-[13px] leading-[18px] tracking-[-0.25px] hover:bg-kumo-elevated/40">
        <WorkshopIconButton
          onClick={onToggleExpand}
          className="!h-7 !w-7"
          aria-label={isExpanded ? 'Collapse action details' : 'Expand action details'}
        >
          <CaretRight
            size={14}
            className={`transition-transform duration-150 ease-out ${isExpanded ? 'rotate-90' : ''}`}
          />
        </WorkshopIconButton>
        <div className="pr-4 font-mono text-[12px] leading-[18px] tracking-[-0.2px] text-kumo-subtle">
          <div>{createdTime}</div>
          <div className="text-kumo-inactive">{createdDate}</div>
        </div>
        <div className="flex min-w-0 items-start gap-2 pr-4">
          <GatekeeperIcon
            resourceUrl={record.resourceUrl}
            bindingName={record.bindingName}
            size={14}
            className="mt-0.5 h-7 w-7 rounded-md"
          />
          <div className="min-w-0">
            {safeResourceUrl ? (
              <a href={safeResourceUrl} target="_blank" rel="noopener noreferrer" className="block truncate font-medium text-kumo-default hover:underline">
                {record.resourceTitle}
              </a>
            ) : (
              <p className="m-0 truncate font-medium text-kumo-default">{record.resourceTitle}</p>
            )}
            {record.bindingName && (
              <p className="m-0 mt-0.5 truncate font-mono text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
                {record.bindingName}
              </p>
            )}
          </div>
        </div>
        <div className="min-w-0 pr-4">
          <p className="m-0 line-clamp-2 text-kumo-default">
            {record.description.title}
          </p>
        </div>
        <div>
          <StatusPill state={record.state} label={statusLabel} />
        </div>
      </div>

      {isExpanded && (
        <div className="px-3 pb-3 pl-[56px]">
          <div className="rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-2.5">
            {record.appliedAt && (
              <p className="mb-2 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                Resolved {formatDate(record.appliedAt)}
              </p>
            )}
            <p className="m-0 whitespace-pre-wrap text-[12px] leading-[18px] font-normal tracking-[-0.2px] text-kumo-subtle">
              {record.description.description}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function StatusPill({ state, label }: { state: ActionLogEntry['state']; label: string }) {
  const className = state === 'pending'
    ? 'border-kumo-brand/20 bg-kumo-brand/10 text-kumo-strong'
    : state === 'approved'
      ? 'border-kumo-line bg-kumo-tint text-kumo-subtle'
      : 'border-kumo-danger/20 bg-kumo-danger-tint text-kumo-danger'

  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium tracking-[-0.2px] ${className}`}>
      {label}
    </span>
  )
}
