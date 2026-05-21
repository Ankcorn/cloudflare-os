import { useState, useEffect } from 'react'
import { Badge, Text } from '@cloudflare/kumo'
import { ArrowSquareOut } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import { RpcStub } from 'capnweb'
import { Overseer, GatekeeperMetadata } from '@gadgets/workshop-shared/api'
import { logoComponents } from '../ConnectionLogos'

interface GatekeeperRow {
  bindingName: string
  resourceTitle: string
}

interface ConnectionsTabProps {
  overseer?: RpcStub<Overseer>
}

// Best-effort logo lookup from a resource title like "Google Drive" or "GitHub Repos".
// Tries the first word lowercased (e.g. "google", "github") which covers all current
// vendors. Falls back to null when there's no match.
function findLogo(resourceTitle: string) {
  const first = resourceTitle.toLowerCase().split(' ')[0]
  return logoComponents[first] ?? null
}

function GatekeeperRow({ gk }: { gk: GatekeeperRow }) {
  const Logo = findLogo(gk.resourceTitle)

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-kumo-fill hover:bg-kumo-tint transition-colors">
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-kumo-tint"
      >
        {Logo ? (
          <Logo size={16} />
        ) : (
          <span className="text-xs font-semibold text-kumo-strong">
            {gk.resourceTitle[0]?.toUpperCase()}
          </span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Text variant="body" size="sm" bold as="span">
            {gk.resourceTitle}
          </Text>
          {gk.bindingName && (
            <span className="font-mono text-xs text-kumo-subtle">
              {gk.bindingName}
            </span>
          )}
        </div>
      </div>

      <Badge variant="success">Active</Badge>
    </div>
  )
}

export default function ConnectionsTab({ overseer }: ConnectionsTabProps) {
  const [gatekeepers, setGatekeepers] = useState<GatekeeperMetadata[]>([])
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    if (!overseer) return
    let cancelled = false
    setLoadError(false)

    overseer.listGatekeepers().then((list) => {
      if (!cancelled) setGatekeepers(list)
    }).catch((err) => {
      console.error('Failed to load connections:', err)
      if (!cancelled) setLoadError(true)
    })

    return () => { cancelled = true }
  }, [overseer])

  return (
    <div className="flex flex-col h-full overflow-auto">
      {gatekeepers.length > 0 ? (
        <>
          <div className="px-4 pt-3 pb-1">
            <span className="font-mono text-[10px] text-kumo-subtle uppercase tracking-wider">
              Active ({gatekeepers.length})
            </span>
          </div>
          {gatekeepers.map((gk) => (
            <GatekeeperRow key={gk.bindingName} gk={gk} />
          ))}
        </>
      ) : loadError ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center py-8">
            <p className="text-sm text-kumo-danger">Failed to load connections</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center py-8">
            <p className="text-sm text-kumo-subtle">No connections configured</p>
            <p className="text-xs text-kumo-inactive mt-1">
              Ask the AI to connect to a service to get started
            </p>
          </div>
        </div>
      )}

      <div className="mt-auto px-4 py-3 border-t border-kumo-fill bg-kumo-elevated flex items-center justify-center">
        <Link
          to="/gatekeepers"
          className="flex items-center gap-1.5 text-xs text-kumo-subtle hover:text-kumo-default transition-colors"
        >
          <ArrowSquareOut size={12} />
          Manage gatekeepers
        </Link>
      </div>
    </div>
  )
}
