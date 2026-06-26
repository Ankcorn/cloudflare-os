import { Link, useRouterState, type LinkProps } from '@tanstack/react-router'
import type { ReactNode } from 'react'

// A single nav row in the sidebar. Renders as a TanStack <Link>. Active state is computed from the
// current router pathname so we can also tint the icon (TanStack's activeProps only swaps top-level
// className, not child styles). When `collapsed` is true the label is hidden but kept in the DOM for
// screen readers / hover-tooltips.
export type SidebarItemProps = {
  icon: ReactNode
  label: string
  to: LinkProps['to']
  params?: LinkProps['params']
  trailing?: ReactNode
  collapsed?: boolean
  /** When true, match this item active when the current path starts with `to`. */
  matchPrefix?: boolean
}

export default function SidebarItem({
  icon,
  label,
  to,
  params,
  trailing,
  collapsed = false,
  matchPrefix = false,
}: SidebarItemProps) {
  // Resolve the active path manually so we can style the icon as well as the row.
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const target = typeof to === 'string' ? to : ''
  const isActive = matchPrefix
    ? pathname === target || pathname.startsWith(target + '/')
    : pathname === target

  // Kept loose: the generated route-tree union is stricter than is convenient for a generic row.
  const linkProps = { to, params } as unknown as LinkProps

  return (
    <Link
      {...linkProps}
      title={collapsed ? label : undefined}
      className={[
        'group relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] leading-[18px] tracking-[-0.25px] transition-colors',
        isActive
          ? 'bg-kumo-fill font-medium text-kumo-strong'
          : 'font-normal text-kumo-default hover:bg-kumo-tint',
      ].join(' ')}
    >
      <span
        className={[
          'flex h-5 w-5 shrink-0 items-center justify-center transition-colors',
          isActive ? 'text-kumo-brand' : 'text-kumo-subtle group-hover:text-kumo-default',
        ].join(' ')}
      >
        {icon}
      </span>
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {trailing && <span className="shrink-0 text-kumo-inactive">{trailing}</span>}
        </>
      )}
    </Link>
  )
}
