export function GatekeeperIcon({
  vendorId,
  bindingName,
  size = 16,
  className = 'h-8 w-8 rounded-lg',
}: {
  vendorId?: string
  bindingName?: string
  size?: number
  className?: string
}) {
  const fallback = bindingName || vendorId || '?'

  return (
    <div
      className={`flex shrink-0 items-center justify-center ${className}`}
      style={{ backgroundColor: 'var(--color-kumo-tint)' }}
    >
      <span className="font-medium text-kumo-strong" style={{ fontSize: Math.max(11, Math.round(size * 0.7)) }}>
        {fallback[0].toUpperCase()}
      </span>
    </div>
  )
}
