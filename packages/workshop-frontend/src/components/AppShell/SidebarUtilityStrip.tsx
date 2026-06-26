import { Link, useRouterState } from '@tanstack/react-router'
import { Plug } from '@phosphor-icons/react'
import { Tooltip } from '@cloudflare/kumo'
import UserMenu from '../UserMenu'

// Bottom strip on the sidebar: tiny iconography for connections and the user menu. Mirrors the
// very low-chrome bottom row in the reference design. We omit a theme toggle for now (no dark mode
// yet) and surface Profile / Providers / Admin from the user-menu dropdown rather than duplicating
// them as separate icons (the standalone Settings gear used to link to /profile, same as the menu).
function StripLink({
  to,
  label,
  matchPrefix,
  children,
}: {
  to: '/gatekeepers'
  label: string
  matchPrefix?: boolean
  children: React.ReactNode
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const active = matchPrefix ? pathname === to || pathname.startsWith(to + '/') : pathname === to
  return (
    <Tooltip content={label}>
      <Link
        to={to}
        aria-label={label}
        className={[
          'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
          active
            ? 'bg-kumo-fill text-kumo-brand'
            : 'text-kumo-inactive hover:bg-kumo-tint hover:text-kumo-default',
        ].join(' ')}
      >
        {children}
      </Link>
    </Tooltip>
  )
}

export default function SidebarUtilityStrip({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div
      className={[
        // shrink-0 + solid base so the strip is visually pinned above the scrolling rail body
        // and content can't bleed through it. Flat treatment — no top shadow.
        'shrink-0 flex items-center gap-1 border-t border-kumo-line bg-kumo-elevated px-3 py-2',
        collapsed ? 'flex-col justify-center gap-2 px-1.5' : '',
      ].join(' ')}
    >
      <StripLink to="/gatekeepers" label="Gatekeepers" matchPrefix>
        <Plug size={15} />
      </StripLink>
      <div className={collapsed ? '' : 'ml-auto'}>
        <UserMenu />
      </div>
    </div>
  )
}
