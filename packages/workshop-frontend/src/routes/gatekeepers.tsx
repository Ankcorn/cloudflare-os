import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import {
  MagnifyingGlass,
  ArrowsClockwise,
  Plus,
  CaretRight,
  Hexagon,
  ShieldCheck,
  Plugs,
} from '@phosphor-icons/react'
import { RpcTarget } from 'capnweb'
import { useAuthenticatedApi } from '../AuthContext'
import { EmptyState } from '../components/EmptyState'
import ConnectConnectorModal from '../components/ConnectConnectorModal'
import {
  AccountDescription,
  SupportedResource,
  VendorDescription,
  VendorScope,
} from '@gadgets/workshop-shared/gatekeeper'
import { ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import { formatDocumentTitle, useDocumentTitle } from '../useDocumentTitle'

export const Route = createFileRoute('/gatekeepers')({
  component: ConnectorsPage,
})

interface AccountEntry {
  id: number
  accountDescription: AccountDescription
  vendorId: string
  vendorDescription: VendorDescription
  supportedResources: SupportedResource[]
  credentialsValid: boolean
}

interface VendorEntry {
  id: string
  description: VendorDescription
  supportedResources: SupportedResource[]
}

function VendorIconTile({
  logoUrl,
  color,
  fallback,
  size = 28,
  className = 'h-12 w-12 rounded-2xl',
}: {
  logoUrl?: string
  color?: string
  fallback: string
  size?: number
  className?: string
}) {
  return (
    <div
      className={`relative grid shrink-0 place-items-center ${className}`}
      style={{ backgroundColor: color ?? 'var(--color-kumo-tint)' }}
    >
      {logoUrl ? (
        <img src={logoUrl} alt="" className="object-contain" style={{ width: size, height: size }} />
      ) : (
        <span className="text-[15px] font-semibold text-kumo-strong">
          {fallback[0]?.toUpperCase() ?? '?'}
        </span>
      )}
    </div>
  )
}

interface ConnectorCardProps {
  logoUrl?: string
  color?: string
  fallback: string
  name: string
  badge?: { label: string; tone: 'new' | 'popular' }
  metaLine?: React.ReactNode
  tagline?: string
  state: 'connected' | 'available' | 'expired'
  onClick: () => void
  onReconnect?: () => void
  reconnectBusy?: boolean
}

function ConnectorCard({
  logoUrl,
  color,
  fallback,
  name,
  badge,
  metaLine,
  tagline,
  state,
  onClick,
  onReconnect,
  reconnectBusy = false,
}: ConnectorCardProps) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.currentTarget !== event.target) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onClick()
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className="group grid w-full cursor-pointer grid-cols-[48px_1fr_auto] items-center gap-4 rounded-2xl border border-kumo-line bg-kumo-base px-5 py-5 text-left transition-[border-color,transform,box-shadow] duration-150 ease-out hover:-translate-y-px hover:border-kumo-fill hover:shadow-[0_8px_20px_-16px_rgba(82,16,0,0.12)] active:scale-[0.995]"
    >
      <div className="self-start">
        <div className="relative">
          <VendorIconTile logoUrl={logoUrl} color={color} fallback={fallback} />
          {state === 'connected' && (
            <span
              className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-[#2a8e3a] ring-2 ring-kumo-base"
              aria-hidden
            />
          )}
          {state === 'expired' && (
            <span
              className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-kumo-danger ring-2 ring-kumo-base"
              aria-hidden
            />
          )}
        </div>
      </div>

      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] leading-5 font-medium tracking-[-0.25px] text-kumo-default">
            {name}
          </span>
          {badge && (
            <span
              className={`rounded-full px-1.5 py-0.5 text-[10px] leading-3 font-semibold uppercase tracking-[0.4px] ${
                badge.tone === 'new'
                  ? 'bg-[rgba(255,72,1,0.10)] text-kumo-brand'
                  : 'bg-kumo-tint text-kumo-subtle'
              }`}
            >
              {badge.label}
            </span>
          )}
        </div>
        {metaLine && (
          <div className="mt-0.5 flex items-center gap-1.5 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
            {metaLine}
          </div>
        )}
        {tagline && (
          <p className="mt-2 line-clamp-2 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
            {tagline}
          </p>
        )}
      </div>

      <div className="self-center">
        {state === 'expired' && onReconnect ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              if (!reconnectBusy) onReconnect()
            }}
            disabled={reconnectBusy}
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-kumo-line bg-kumo-base px-3 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-default transition-[background-color,border-color,opacity,transform] duration-150 ease-out hover:border-kumo-fill hover:bg-kumo-tint active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100"
          >
            <ArrowsClockwise size={12} weight="bold" />
            {reconnectBusy ? 'Opening...' : 'Reconnect'}
          </button>
        ) : (
          <div className="grid h-7 w-7 place-items-center text-kumo-inactive transition-colors group-hover:text-kumo-default">
            {state === 'available' ? (
              <Plus size={16} weight="bold" />
            ) : (
              <CaretRight size={14} weight="bold" />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function SectionEyebrow({ label, count }: { label: string; count?: number }) {
  return (
    <div className="mb-3.5 flex items-center gap-3 px-1">
      <h2 className="m-0 text-[11px] leading-4 font-semibold uppercase tracking-[0.9px] text-kumo-subtle">
        {label}
      </h2>
      <div className="h-px flex-1 bg-kumo-line" />
      {typeof count === 'number' && (
        <span className="text-[11px] leading-4 font-semibold tracking-[-0.1px] text-kumo-inactive">
          {count}
        </span>
      )}
    </div>
  )
}

function ConnectorsHeroDiagram({
  accounts,
  vendors,
}: {
  accounts: AccountEntry[]
  vendors: VendorEntry[]
}) {
  const [hoveredSource, setHoveredSource] = useState<number | null>(null)
  const seen = new Set<string>()
  const nodes = [
    ...accounts.map((account) => ({
      key: `account-${account.id}`,
      vendorId: account.vendorId,
      logoUrl: account.vendorDescription.logo?.url,
      color: account.vendorDescription.color,
      fallback: account.vendorDescription.displayName,
    })),
    ...vendors.map((vendor) => ({
      key: `vendor-${vendor.id}`,
      vendorId: vendor.id,
      logoUrl: vendor.description.logo?.url,
      color: vendor.description.color,
      fallback: vendor.description.displayName,
    })),
  ].filter((node) => {
    if (seen.has(node.vendorId)) return false
    seen.add(node.vendorId)
    return true
  }).slice(0, 3)

  const sourceNodes = [
    { className: 'left-1 top-3', x: 4, y: 12 },
    { className: 'left-10 top-[62px]', x: 40, y: 62 },
    { className: 'left-1 bottom-3', x: 4, y: 120 },
  ]
  const nodeSize = 44
  const gatekeeper = { x: 176, y: 58, width: 52, height: 52 }
  const gadget = { x: 268, y: 58, width: 120, height: 52 }
  const gatekeeperInput = {
    x: gatekeeper.x,
    y: gatekeeper.y + gatekeeper.height / 2,
  }
  const gatekeeperOutput = {
    x: gatekeeper.x + gatekeeper.width,
    y: gatekeeper.y + gatekeeper.height / 2,
  }
  const gadgetInput = {
    x: gadget.x,
    y: gadget.y + gadget.height / 2,
  }

  const sourcePoint = (index: number) => ({
    x: sourceNodes[index].x + nodeSize,
    y: sourceNodes[index].y + nodeSize / 2,
  })
  const inputPath = (index: number) => {
    const start = sourcePoint(index)
    const end = gatekeeperInput
    const dx = end.x - start.x
    return `M${start.x} ${start.y} C${start.x + dx * 0.45} ${start.y} ${end.x - dx * 0.35} ${end.y} ${end.x} ${end.y}`
  }

  return (
    <div className="relative isolate hidden h-[176px] w-[392px] lg:block">
      <svg
        className="absolute inset-0 h-full w-full text-kumo-line"
        viewBox="0 0 392 176"
        fill="none"
      >
        {nodes[0] && (
          <path
            d={inputPath(0)}
            className={hoveredSource === 0 ? 'connectors-hero-flow-line' : ''}
            stroke="currentColor"
            strokeWidth="1.2"
            strokeDasharray="3 7"
          />
        )}
        {nodes[1] && (
          <path
            d={inputPath(1)}
            className={hoveredSource === 1 ? 'connectors-hero-flow-line' : ''}
            stroke="currentColor"
            strokeWidth="1.2"
            strokeDasharray="3 7"
          />
        )}
        {nodes[2] && (
          <path
            d={inputPath(2)}
            className={hoveredSource === 2 ? 'connectors-hero-flow-line' : ''}
            stroke="currentColor"
            strokeWidth="1.2"
            strokeDasharray="3 7"
          />
        )}
        <path
          d={`M${gatekeeperOutput.x} ${gatekeeperOutput.y} L${gadgetInput.x} ${gadgetInput.y}`}
          stroke="currentColor"
          strokeWidth="1.2"
        />
        {hoveredSource !== null && (
          <path
            d={`M${gatekeeperOutput.x} ${gatekeeperOutput.y} L${gadgetInput.x} ${gadgetInput.y}`}
            className="connectors-hero-flow-line"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeDasharray="3 7"
          />
        )}
      </svg>

      {nodes.length > 0 ? (
        nodes.map((node, index) => (
          <div
            key={node.key}
            onMouseEnter={() => setHoveredSource(index)}
            onMouseLeave={() => setHoveredSource(null)}
            onFocus={() => setHoveredSource(index)}
            onBlur={() => setHoveredSource(null)}
            className={`absolute grid h-11 w-11 place-items-center rounded-2xl border border-kumo-line bg-kumo-base/85 backdrop-blur-sm transition-[border-color,transform,box-shadow] duration-150 ease-out hover:-translate-y-px hover:border-kumo-fill hover:shadow-[0_8px_20px_-16px_rgba(82,16,0,0.18)] ${sourceNodes[index].className}`}
          >
            <VendorIconTile
              logoUrl={node.logoUrl}
              color={node.color}
              fallback={node.fallback}
              size={18}
              className="h-8 w-8 rounded-xl"
            />
          </div>
        ))
      ) : (
        <>
          {sourceNodes.map((node, index) => (
            <div
              key={index}
              onMouseEnter={() => setHoveredSource(index)}
              onMouseLeave={() => setHoveredSource(null)}
              className={`absolute h-11 w-11 rounded-2xl border border-kumo-line bg-kumo-base/50 transition-[border-color,transform,box-shadow] duration-150 ease-out hover:-translate-y-px hover:border-kumo-fill hover:shadow-[0_8px_20px_-16px_rgba(82,16,0,0.18)] ${node.className}`}
            />
          ))}
        </>
      )}

      <div className="group absolute left-[176px] top-[58px] z-20">
        <button
          type="button"
          className="grid h-[52px] w-[52px] place-items-center rounded-2xl border border-kumo-line bg-kumo-base/90 text-kumo-brand backdrop-blur-sm transition-[border-color,box-shadow] hover:border-kumo-fill hover:shadow-[0_8px_24px_-18px_rgba(82,16,0,0.22)] focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring focus-visible:ring-offset-2 focus-visible:ring-offset-kumo-base"
          aria-label="Gatekeeper keeps Gadget access limited to connected resources"
        >
          <ShieldCheck size={21} weight="duotone" />
        </button>
        <div className="pointer-events-none absolute left-1/2 top-[-108px] z-30 w-[228px] origin-bottom -translate-x-1/2 translate-y-1 scale-[0.98] rounded-2xl border border-kumo-line bg-kumo-base/95 p-3 text-left opacity-0 shadow-[0_18px_44px_-30px_rgba(82,16,0,0.34)] backdrop-blur-md transition-[opacity,transform] delay-0 duration-150 ease-out group-hover:translate-y-0 group-hover:scale-100 group-hover:opacity-100 group-hover:delay-100 group-focus-within:translate-y-0 group-focus-within:scale-100 group-focus-within:opacity-100 group-focus-within:delay-100">
          <div className="flex items-start gap-2.5">
            <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-kumo-tint text-kumo-brand">
              <ShieldCheck size={16} weight="duotone" />
            </div>
            <div className="min-w-0">
              <p className="m-0 text-[12px] leading-4 font-semibold tracking-[-0.2px] text-kumo-default">
                Gatekeeper
              </p>
              <p className="mt-1 text-[11px] leading-4 font-normal tracking-[-0.1px] text-kumo-subtle">
                Keeps each Gadget limited to the resources you connect and ensures every user has the required permissions before accessing them.
              </p>
            </div>
          </div>
          <span className="absolute left-1/2 bottom-[-5px] h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-b border-r border-kumo-line bg-kumo-base" />
        </div>
      </div>

      <div className="absolute left-[268px] top-[58px] z-10 flex h-[52px] w-[120px] items-center gap-2 rounded-2xl border border-kumo-line bg-kumo-elevated/90 pl-2 pr-4 backdrop-blur-sm">
        <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-kumo-base text-kumo-brand">
          <Hexagon size={17} weight="bold" />
        </div>
        <span className="relative -top-px text-base leading-5 font-semibold tracking-tight text-kumo-default">
          gadgets
        </span>
      </div>
    </div>
  )
}

type ModalTarget =
  | { kind: 'connect'; vendorId: string }
  | { kind: 'manage'; accountId: number }
  | null

function ConnectorsPage() {
  useDocumentTitle(formatDocumentTitle('Gatekeepers'))

  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()

  const [search, setSearch] = useState('')
  const [accounts, setAccounts] = useState<AccountEntry[]>([])
  const [vendors, setVendors] = useState<VendorEntry[]>([])
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  const [vendorsLoaded, setVendorsLoaded] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const [modalTarget, setModalTarget] = useState<ModalTarget>(null)
  const [scopeCatalog, setScopeCatalog] = useState<VendorScope[]>([])
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  const [reconnectingAccountId, setReconnectingAccountId] = useState<number | null>(null)

  const subscriptionRef = useRef<{ [Symbol.dispose](): void } | null>(null)
  const scopeCatalogCacheRef = useRef(new Map<string, VendorScope[]>())
  const scopeCatalogRequestsRef = useRef(new Map<string, Promise<VendorScope[]>>())
  const retryCatalogRequestRef = useRef(0)
  const targetVendorIdRef = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      targetVendorIdRef.current = null
      retryCatalogRequestRef.current += 1
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const accountMap = new Map<number, AccountEntry>()

    setAccountsLoaded(false)
    setVendorsLoaded(false)

    authenticatedApi
      .listGatekeeperVendors()
      .then((vendorList) => {
        if (cancelled) return
        setVendors(
          vendorList.map((v) => ({
            id: v.id,
            description: v.description,
            supportedResources: v.supportedResources,
          })),
        )
        setVendorsLoaded(true)
      })
      .catch((err) => {
        console.error('Failed to load available services:', err)
        if (!cancelled) setLoadError(true)
      })

    class AccountsSubscriber
      extends RpcTarget
      implements ConnectedAccountsSubscriber
    {
      add(
        id: number,
        description: AccountDescription,
        vendor: VendorDescription,
        supportedResources: SupportedResource[] = [],
        credentialsValid: boolean = true,
        vendorId: string = '',
      ) {
        if (cancelled) return
        accountMap.set(id, {
          id,
          accountDescription: description,
          vendorId,
          vendorDescription: vendor,
          supportedResources,
          credentialsValid,
        })
        setAccounts(Array.from(accountMap.values()))
      }
      remove(id: number) {
        accountMap.delete(id)
        if (!cancelled) setAccounts(Array.from(accountMap.values()))
      }
      ready() {
        if (!cancelled) setAccountsLoaded(true)
      }
    }

    const subscriber = new AccountsSubscriber()

    authenticatedApi
      .subscribeConnectedAccounts(subscriber)
      .then((stub) => {
        if (cancelled) {
          stub[Symbol.dispose]()
        } else {
          subscriptionRef.current = stub
        }
      })
      .catch((err) => {
        console.error('Failed to subscribe to connected accounts:', err)
        if (!cancelled) setLoadError(true)
      })

    return () => {
      cancelled = true
      subscriptionRef.current?.[Symbol.dispose]()
      subscriptionRef.current = null
    }
  }, [authenticatedApi])

  const targetVendorId = useMemo(() => {
    if (!modalTarget) return null
    if (modalTarget.kind === 'connect') return modalTarget.vendorId
    const account = accounts.find((a) => a.id === modalTarget.accountId)
    return account?.vendorId ?? null
  }, [modalTarget, accounts])

  useEffect(() => {
    targetVendorIdRef.current = targetVendorId
    retryCatalogRequestRef.current += 1
  }, [targetVendorId])

  function loadScopeCatalog(vendorId: string): Promise<VendorScope[]> {
    const cached = scopeCatalogCacheRef.current.get(vendorId)
    if (cached) return Promise.resolve(cached)

    const inFlight = scopeCatalogRequestsRef.current.get(vendorId)
    if (inFlight) return inFlight

    const request = authenticatedApi
      .getGatekeeperScopeCatalog(vendorId)
      .then((catalog) => {
        scopeCatalogCacheRef.current.set(vendorId, catalog)
        scopeCatalogRequestsRef.current.delete(vendorId)
        return catalog
      })
      .catch((err) => {
        scopeCatalogRequestsRef.current.delete(vendorId)
        throw err
      })

    scopeCatalogRequestsRef.current.set(vendorId, request)
    return request
  }

  useEffect(() => {
    if (!targetVendorId) return
    let cancelled = false
    const cached = scopeCatalogCacheRef.current.get(targetVendorId)
    if (cached) {
      setScopeCatalog(cached)
      setLoadingCatalog(false)
      setCatalogError(null)
      return
    }

    setScopeCatalog([])
    setLoadingCatalog(true)
    setCatalogError(null)
    loadScopeCatalog(targetVendorId)
      .then((catalog) => {
        if (cancelled) return
        setScopeCatalog(catalog)
        setCatalogError(null)
      })
      .catch((err) => {
        console.error('Failed to load scope catalog:', err)
        if (!cancelled) {
          setScopeCatalog([])
          setCatalogError('Failed to load permissions')
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingCatalog(false)
      })
    return () => {
      cancelled = true
    }
  }, [targetVendorId, authenticatedApi])

  const handleOpenConnect = (vendorId: string) => {
    setModalTarget({ kind: 'connect', vendorId })
  }

  const handleOpenManage = (accountId: number) => {
    setModalTarget({ kind: 'manage', accountId })
  }

  const handleCloseModal = () => {
    targetVendorIdRef.current = null
    retryCatalogRequestRef.current += 1
    setModalTarget(null)
  }

  const handleConfirmConnect = async () => {
    if (!modalTarget || modalTarget.kind !== 'connect') return
    setConnecting(true)
    try {
      const { url } = await authenticatedApi.connectAccount(modalTarget.vendorId)
      window.open(url, '_blank', 'noopener,noreferrer')
      handleCloseModal()
    } catch (err) {
      console.error('Failed to connect account:', err)
      toasts.add({ title: 'Failed to start connection', variant: 'error' })
    } finally {
      setConnecting(false)
    }
  }

  const handleRetryCatalog = () => {
    if (!targetVendorId) return
    const requestId = retryCatalogRequestRef.current + 1
    retryCatalogRequestRef.current = requestId
    const vendorId = targetVendorId
    setCatalogError(null)
    setLoadingCatalog(true)
    void loadScopeCatalog(vendorId)
      .then((catalog) => {
        if (retryCatalogRequestRef.current !== requestId || targetVendorIdRef.current !== vendorId) return
        setScopeCatalog(catalog)
        setCatalogError(null)
      })
      .catch((err) => {
        console.error('Failed to load scope catalog:', err)
        if (retryCatalogRequestRef.current !== requestId || targetVendorIdRef.current !== vendorId) return
        setScopeCatalog([])
        setCatalogError('Failed to load permissions')
      })
      .finally(() => {
        if (retryCatalogRequestRef.current === requestId && targetVendorIdRef.current === vendorId) {
          setLoadingCatalog(false)
        }
      })
  }

  const handleDisconnect = async () => {
    if (!modalTarget || modalTarget.kind !== 'manage') return
    setDisconnecting(true)
    try {
      await authenticatedApi.disconnectAccount(modalTarget.accountId)
      handleCloseModal()
    } catch (err) {
      console.error('Failed to disconnect account:', err)
      toasts.add({ title: 'Failed to disconnect account', variant: 'error' })
    } finally {
      setDisconnecting(false)
    }
  }

  const handleReconnect = async (accountId: number) => {
    setReconnectingAccountId(accountId)
    try {
      const { url } = await authenticatedApi.reconnectAccount(accountId)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (err) {
      console.error('Failed to reconnect account:', err)
      toasts.add({ title: 'Failed to reconnect account', variant: 'error' })
    } finally {
      setReconnectingAccountId(null)
    }
  }

  const searchLower = search.toLowerCase()
  const filteredAccounts = useMemo(() => {
    const matchesSearch = (text: string | undefined) =>
      !searchLower || (text ?? '').toLowerCase().includes(searchLower)
    const resourcesForAccountFilter = (account: AccountEntry) =>
      vendors.find((v) => v.id === account.vendorId)?.supportedResources ??
      account.supportedResources

    return accounts.filter((a) => {
      const resources = resourcesForAccountFilter(a)
      return (
        matchesSearch(a.accountDescription.displayName) ||
        matchesSearch(a.accountDescription.uniqueName) ||
        matchesSearch(a.vendorDescription.displayName) ||
        matchesSearch(a.vendorDescription.tagline) ||
        resources.some((r) => matchesSearch(r.title))
      )
    })
  }, [accounts, vendors, searchLower])

  const filteredAvailable = useMemo(() => {
    const matchesSearch = (text: string | undefined) =>
      !searchLower || (text ?? '').toLowerCase().includes(searchLower)

    return vendors.filter(
      (v) =>
        matchesSearch(v.description.displayName) ||
        matchesSearch(v.description.tagline) ||
        v.supportedResources.some((r) => matchesSearch(r.title)),
    )
  }, [vendors, searchLower])

  const activeAccount: AccountEntry | undefined =
    modalTarget?.kind === 'manage'
      ? accounts.find((a) => a.id === modalTarget.accountId)
      : undefined
  const activeVendor: VendorEntry | undefined =
    modalTarget?.kind === 'connect'
      ? vendors.find((v) => v.id === modalTarget.vendorId)
      : activeAccount
      ? vendors.find((v) => v.id === activeAccount.vendorId) ?? {
          id: activeAccount.vendorId,
          description: activeAccount.vendorDescription,
          supportedResources: activeAccount.supportedResources,
        }
      : undefined

  const initialLoading =
    !loadError &&
    (!vendorsLoaded || !accountsLoaded) &&
    vendors.length === 0 &&
    accounts.length === 0

  return (
    <div className="relative min-h-[calc(100vh-3.5rem-1px)] overflow-hidden bg-kumo-base">
      <div
        className="pointer-events-none absolute inset-0 h-[320px]"
        style={{
          backgroundImage:
            'radial-gradient(circle, var(--color-kumo-line) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
          maskImage:
            'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 80%)',
          WebkitMaskImage:
            'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 80%)',
        }}
      />

      <div className="relative mx-auto w-full max-w-[1040px] px-4 py-12 sm:px-8 sm:py-14">
        <header className="mb-8 grid gap-8 lg:grid-cols-[minmax(0,540px)_392px] lg:items-center lg:justify-between">
          <div>
            <h1 className="m-0 text-[32px] leading-[1.05] font-semibold tracking-[-1.2px] text-kumo-default sm:text-[38px]">
              Your gatekeepers
            </h1>
            <p className="mt-3 text-[15px] leading-[22px] font-normal tracking-[-0.25px] text-kumo-subtle">
              Add the apps and accounts your Gadgets can use. Connect once, then wire
              them into anything you build.
            </p>
          </div>
          <ConnectorsHeroDiagram accounts={accounts} vendors={vendors} />
        </header>

        <div className="relative mb-5">
          <MagnifyingGlass
            size={18}
            className="pointer-events-none absolute left-[18px] top-1/2 -translate-y-1/2 text-kumo-subtle"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search gatekeepers"
            className="!h-[52px] w-full rounded-[14px] border border-kumo-line bg-kumo-base pl-12 pr-4 text-[15px] leading-5 font-normal tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive shadow-none transition-[border-color,box-shadow] focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-black/5"
          />
        </div>

        {loadError && (
          <div className="rounded-2xl border border-kumo-line bg-kumo-base px-4 py-6 text-center">
            <p className="m-0 text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-danger">
              Something went wrong loading your gatekeepers.
            </p>
            <p className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              Check your connection and try refreshing the page.
            </p>
          </div>
        )}

        {initialLoading && (
          <div className="rounded-2xl border border-kumo-line bg-kumo-base px-4 py-8 text-center text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
            Loading gatekeepers...
          </div>
        )}

        {filteredAccounts.length > 0 && (
          <section className="mb-10">
            <SectionEyebrow label="Connected" count={filteredAccounts.length} />
            <div className="grid gap-3 sm:grid-cols-2">
              {filteredAccounts.map((account) => {
                const displayName =
                  account.accountDescription.displayName ??
                  account.accountDescription.uniqueName ??
                  'Connected'
                const tagline =
                  account.vendorDescription.tagline ??
                  (account.accountDescription.scope.length > 0
                    ? account.accountDescription.scope.join(' / ')
                    : undefined)
                return (
                  <ConnectorCard
                    key={account.id}
                    logoUrl={account.vendorDescription.logo?.url}
                    color={account.vendorDescription.color}
                    fallback={account.vendorDescription.displayName}
                    name={account.vendorDescription.displayName}
                    metaLine={
                      <span
                        className={`truncate ${
                          account.credentialsValid ? '' : 'text-kumo-danger'
                        }`}
                      >
                        {account.credentialsValid
                          ? displayName
                          : 'Credentials expired'}
                      </span>
                    }
                    tagline={tagline}
                    state={account.credentialsValid ? 'connected' : 'expired'}
                    onClick={() => handleOpenManage(account.id)}
                    onReconnect={() => handleReconnect(account.id)}
                    reconnectBusy={reconnectingAccountId === account.id}
                  />
                )
              })}
            </div>
          </section>
        )}

        {filteredAvailable.length > 0 && (
          <section className="mb-10">
            <SectionEyebrow label="Available" />
            <div className="grid gap-3 sm:grid-cols-2">
              {filteredAvailable.map((vendor) => (
                <ConnectorCard
                  key={vendor.id}
                  logoUrl={vendor.description.logo?.url}
                  color={vendor.description.color}
                  fallback={vendor.description.displayName}
                  name={vendor.description.displayName}
                  tagline={vendor.description.tagline}
                  state="available"
                  onClick={() => handleOpenConnect(vendor.id)}
                />
              ))}
            </div>
          </section>
        )}

        {!initialLoading &&
          !loadError &&
          filteredAccounts.length === 0 &&
          filteredAvailable.length === 0 && (
            <EmptyState
              title={
                search
                  ? 'No gatekeepers match'
                  : 'No gatekeepers yet'
              }
              description={
                search
                  ? "We couldn't find anything matching your search."
                  : 'Gatekeepers will appear here as they become available in your workspace.'
              }
              icon={Plugs}
            />
          )}

      </div>

      {activeVendor && (
        <ConnectConnectorModal
          open={modalTarget !== null}
          mode={modalTarget?.kind === 'manage' ? 'manage' : 'connect'}
          vendorDescription={activeVendor.description}
          supportedResources={activeVendor.supportedResources}
          scopeCatalog={scopeCatalog}
          loadingCatalog={loadingCatalog}
          catalogError={catalogError}
          logoUrl={activeVendor.description.logo?.url}
          color={activeVendor.description.color}
          onRetryCatalog={handleRetryCatalog}
          connecting={connecting}
          onConfirm={handleConfirmConnect}
          accountDescription={activeAccount?.accountDescription}
          credentialsValid={activeAccount?.credentialsValid}
          disconnecting={disconnecting}
          onDisconnect={handleDisconnect}
          onOpenChange={(open) => {
            if (!open && !connecting && !disconnecting) handleCloseModal()
          }}
        />
      )}
    </div>
  )
}
