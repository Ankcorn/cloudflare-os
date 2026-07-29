import { useMemo, useState, type ReactNode } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { CaretRight, Pulse } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import { EmptyState } from './components/EmptyState'
import { GatekeeperIcon } from './components/GatekeeperIcon'
import { HookToggle } from './components/HookToggle'
import { WorkshopButton, WorkshopIconButton } from './components/WorkshopControls'
import { useActions } from './useActions'
import { useAlwaysApproveTag } from './useAlwaysApproveTag'
import { useAuthenticatedApi } from './AuthContext'
import { useAvatar } from './useAvatar'
import AutoApproveConfirmDialog from './components/AutoApproveConfirmDialog'

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

function timeValue(date: Date | undefined): number {
  return date ? new Date(date).getTime() : 0
}

function compareCreatedDesc(a: ActionLogEntry, b: ActionLogEntry): number {
  return timeValue(b.createdAt) - timeValue(a.createdAt) || b.id - a.id
}

function compareHistoryDesc(a: ActionLogEntry, b: ActionLogEntry): number {
  return timeValue(b.appliedAt ?? b.createdAt) - timeValue(a.appliedAt ?? a.createdAt) || b.id - a.id
}

interface ActivityProps {
  overseer: RpcStub<Overseer>
  onAutoApproveChange?: () => void
}

export default function Activity({ overseer, onAutoApproveChange }: ActivityProps) {
  const { actionsById, isReady } = useActions(overseer)
  const [processingActions, setProcessingActions] = useState<Set<number>>(new Set())
  const [togglingHooks, setTogglingHooks] = useState<Set<number>>(new Set())
  const [expandedActionId, setExpandedActionId] = useState<number | null>(null)
  const [confirmAutoApprove, setConfirmAutoApprove] = useState<
    { actionId: number; gatekeeperId: number; resourceTitle: string;
      actionKind: ActionKind; actionLabel: string } | null
  >(null)
  const toasts = useKumoToastManager()

  const handleToggleHook = async (hookId: number, enabled: boolean) => {
    setTogglingHooks(prev => new Set(prev).add(hookId))
    try {
      if (enabled) {
        await overseer.enableHook(hookId)
      } else {
        await overseer.disableHook(hookId)
      }
      // The action log subscription will deliver the updated record.
    } catch (err) {
      console.error('Failed to toggle hook:', err)
      toasts.add({ title: `Failed to ${enabled ? 'enable' : 'disable'} hook`, variant: 'error' })
    } finally {
      setTogglingHooks(prev => {
        const next = new Set(prev)
        next.delete(hookId)
        return next
      })
    }
  }

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

  const { alwaysApproveTag, isTagAutoApproved } =
    useAlwaysApproveTag(overseer, setProcessingActions, onAutoApproveChange)

  const toggleExpanded = (id: number) => {
    setExpandedActionId(prev => prev === id ? null : id)
  }

  const { pendingActions, historyActions } = useMemo(() => {
    const actions = [...actionsById.values()]

    return {
      pendingActions: actions.filter(record => record.state === 'pending').toSorted(compareCreatedDesc),
      historyActions: actions.filter(record => record.state !== 'pending').toSorted(compareHistoryDesc),
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
                    {pendingActions.map((record, index) => {
                      // Auto-approval target: offer "Always approve this type" only when enabling a
                      // rule would actually apply this action -- i.e. it's a tagged action on a
                      // connection that the gatekeeper marked auto-approvable. (A non-auto-approvable
                      // action stays a manual gate even with a rule, so the button would be a no-op;
                      // and an auto-approvable action with an existing rule wouldn't still be pending.)
                      const autoApproveTarget =
                        record.type === 'action' && record.gatekeeperId !== undefined &&
                        record.description.actionKind !== undefined &&
                        record.description.autoApprovable === true
                          ? {
                              actionId: record.id,
                              gatekeeperId: record.gatekeeperId,
                              resourceTitle: record.resourceTitle,
                              actionKind: record.description.actionKind,
                              actionLabel: record.description.title,
                            }
                          : undefined
                      return (
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
                          onAlwaysApprove={
                            autoApproveTarget &&
                            !isTagAutoApproved(autoApproveTarget.gatekeeperId, autoApproveTarget.actionKind.tag)
                              ? () => setConfirmAutoApprove(autoApproveTarget)
                              : undefined
                          }
                          formatTime={formatTime}
                        />
                      )
                    })}
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
                    togglingHooks={togglingHooks}
                    onToggleHook={handleToggleHook}
                  />
                )}
              </section>
            </div>
          )}
        </section>
      </div>

      {confirmAutoApprove && (
        <AutoApproveConfirmDialog
          open
          actionLabel={confirmAutoApprove.actionLabel}
          resourceTitle={confirmAutoApprove.resourceTitle}
          isProcessing={processingActions.has(confirmAutoApprove.actionId)}
          onOpenChange={(open) => { if (!open) setConfirmAutoApprove(null) }}
          onConfirm={async () => {
            const { actionId, gatekeeperId, actionKind } = confirmAutoApprove
            if (await alwaysApproveTag(actionId, gatekeeperId, actionKind)) {
              setConfirmAutoApprove(null)
            }
          }}
        />
      )}
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
  onAlwaysApprove,
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
  onAlwaysApprove?: () => void
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
            {' '}
            <span className="text-kumo-inactive">·</span>{' '}
            {formatTime(record.createdAt)}
          </p>
        </div>

        {showApprovalActions ? (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {onAlwaysApprove && (
              <WorkshopButton
                className="!h-9"
                onClick={onAlwaysApprove}
                disabled={isProcessing}
              >
                Always approve this type
              </WorkshopButton>
            )}
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
  togglingHooks,
  onToggleHook,
}: {
  actions: ActionLogEntry[]
  expandedActionId: number | null
  onToggleExpand: (id: number) => void
  formatDate: (date: Date) => string
  togglingHooks: Set<number>
  onToggleHook: (hookId: number, enabled: boolean) => void
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
            togglingHooks={togglingHooks}
            onToggleHook={onToggleHook}
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
  togglingHooks,
  onToggleHook,
}: {
  record: ActionLogEntry
  isExpanded: boolean
  isFirst: boolean
  onToggleExpand: () => void
  formatDate: (date: Date) => string
  togglingHooks: Set<number>
  onToggleHook: (hookId: number, enabled: boolean) => void
}) {
  const statusLabel = record.state === 'approved' ? 'Approved' : 'Rejected'
  const safeResourceUrl = getSafeExternalUrl(record.resourceUrl)
  const resolvedBy = record.type === 'action' ? record.resolvedBy : undefined
  const autoApproved = record.type === 'action' ? record.autoApproved === true : false
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
            fallbackText={record.resourceTitle}
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
          </div>
        </div>
        <div className="min-w-0 pr-4">
          <p className="m-0 line-clamp-2 text-kumo-default">
            {record.description.title}
          </p>
          {resolvedBy && autoApproved && (
            <span
              className="mt-1 flex max-w-full items-center gap-1.5 text-[11px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle"
              title={`Auto-approved · rule enabled by ${resolvedBy.name}`}
            >
              <span className="inline-flex shrink-0 items-center rounded-full bg-kumo-elevated px-2 py-0.5 font-medium">
                Auto-approved
              </span>
              <ResolverBadge profileId={resolvedBy.id} className="flex min-w-0 items-center gap-1">
                <span className="truncate">{resolvedBy.name}</span>
              </ResolverBadge>
            </span>
          )}
          {resolvedBy && !autoApproved && (
            <ResolverBadge
              profileId={resolvedBy.id}
              className="mt-1 flex max-w-full items-center gap-1 text-[11px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle"
              title={`${statusLabel} by ${resolvedBy.name}`}
            >
              <span className="truncate">{statusLabel} by {resolvedBy.name}</span>
            </ResolverBadge>
          )}
        </div>
        <div className="flex flex-col items-start gap-1">
          {record.type === 'bindHook' ? (
            record.hookId !== undefined ? (
              <HookToggle
                enabled={record.enabled}
                disabled={togglingHooks.has(record.hookId)}
                onToggle={(enabled) => onToggleHook(record.hookId!, enabled)}
              />
            ) : (
              <span className="shrink-0 rounded-full border border-kumo-line bg-kumo-tint px-2 py-0.5 text-[11px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle">
                Deleted
              </span>
            )
          ) : (
            <StatusPill state={record.state} label={statusLabel} />
          )}
        </div>
      </div>

      {isExpanded && (
        <div className="px-3 pb-3 pl-[56px]">
          <div className="rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-2.5">
            {record.appliedAt && (
              resolvedBy && autoApproved ? (
                <ResolverBadge
                  profileId={resolvedBy.id}
                  className="mb-2 flex items-center gap-1.5 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle"
                >
                  <span>Auto-approved · enabled by {resolvedBy.name} · {formatDate(record.appliedAt)}</span>
                </ResolverBadge>
              ) : resolvedBy ? (
                <ResolverBadge
                  profileId={resolvedBy.id}
                  className="mb-2 flex items-center gap-1.5 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle"
                >
                  <span>{statusLabel} by {resolvedBy.name} · {formatDate(record.appliedAt)}</span>
                </ResolverBadge>
              ) : (
                <p className="mb-2 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                  Resolved {formatDate(record.appliedAt)}
                </p>
              )
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

// Renders a resolver's avatar (when available) alongside caller-provided label content. Isolated
// into its own component so the avatar hooks (useAuthenticatedApi/useAvatar) only run for rows that
// actually have a resolver, rather than for every row in the log.
function ResolverBadge({
  profileId,
  className,
  title,
  children,
}: {
  profileId: string
  className: string
  title?: string
  children: ReactNode
}) {
  const { authenticatedApi } = useAuthenticatedApi()
  const avatarUrl = useAvatar(authenticatedApi, profileId)
  return (
    <span className={className} title={title}>
      {avatarUrl && (
        <img src={avatarUrl} alt="" className="h-4 w-4 shrink-0 rounded-full object-cover" />
      )}
      {children}
    </span>
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
