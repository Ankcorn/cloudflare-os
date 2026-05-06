import { PlugsConnected, type Icon } from '@phosphor-icons/react'
import { WorkshopButton } from './WorkshopControls'

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  icon: EmptyIcon = PlugsConnected,
}: {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
  icon?: Icon
}) {
  return (
    <div className="relative overflow-hidden rounded-xl border border-dashed border-kumo-line bg-kumo-base px-6 py-9 text-center">
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 h-48 w-48 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          background:
            'radial-gradient(circle, rgba(255, 72, 1, 0.06) 0%, rgba(235, 213, 193, 0.12) 38%, transparent 70%)',
          filter: 'blur(14px)',
        }}
      />
      <div
        className="relative mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-kumo-line bg-kumo-elevated text-kumo-subtle"
        style={{
          boxShadow:
            'inset 0 1px 0 rgba(255,255,255,0.72), 0 8px 24px rgba(82,16,0,0.05)',
        }}
      >
        <EmptyIcon size={18} />
      </div>
      <div className="relative">
        <p className="m-0 text-[14px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
          {title}
        </p>
        <p className="mx-auto mt-1 max-w-sm text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
          {description}
        </p>
      </div>
      {actionLabel && onAction && (
        <WorkshopButton
          className="relative mx-auto mt-4"
          onClick={onAction}
        >
          {actionLabel}
        </WorkshopButton>
      )}
    </div>
  )
}
