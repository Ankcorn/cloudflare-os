export function GatekeeperIcon({
  vendorId,
  bindingName,
  logoUrl,
  size = 16,
  className = 'h-8 w-8 rounded-lg',
}: {
  vendorId?: string
  bindingName?: string
  logoUrl?: string
  size?: number
  className?: string
}) {
  const fallback = bindingName || vendorId || '?'

  if (logoUrl) {
    return (
      <div
        className={`flex shrink-0 items-center justify-center overflow-hidden ${className}`}
        style={{ backgroundColor: 'var(--color-kumo-tint)' }}
      >
        <img src={logoUrl} alt="" className="h-full w-full object-contain p-1" />
      </div>
    )
  }

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
