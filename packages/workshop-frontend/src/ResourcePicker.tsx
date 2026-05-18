import { useState, useEffect, useRef, useMemo, useCallback, type MutableRefObject } from 'react'
import { Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import { Plus, CaretRight, Warning } from '@phosphor-icons/react'
import { RpcStub, RpcTarget } from 'capnweb'
import { AuthenticatedApi, ConnenctedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { extractHostname, extractBaseUrl, matchesResource, matchesResourceText, classifyMatch, getPlaceholderRanges } from './resourceMatching'

export interface VendorOption {
  id: string
  description: VendorDescription
  supportedResources: SupportedResource[]
}

export type SelectableItem = {
  type: 'account'
  accountId: number
  vendorId: string
  resource: SupportedResource
  accountDescription: AccountDescription
  vendorDescription: VendorDescription
} | {
  type: 'connect'
  vendorId: string
  vendorDescription: VendorDescription
} | {
  type: 'refine'
  resource: SupportedResource
  vendorDescription: VendorDescription
  suffix: string
  replaceSearch?: boolean
}

export interface ResourcePickerProps {
  authenticatedApi: RpcStub<AuthenticatedApi>
  searchText: string
  onSelectAccount: (
    accountId: number,
    vendorId: string,
    resource: SupportedResource,
    accountDescription: AccountDescription,
    vendorDescription: VendorDescription,
  ) => void
  onRefine?: (newUrl: string, placeholderStart: number, placeholderEnd: number) => void
  compact?: boolean
  style?: React.CSSProperties
  activeIndex?: number
  onItems?: (items: SelectableItem[]) => void
  activateRef?: MutableRefObject<((index: number) => void) | null>
}

export default function ResourcePicker({
  authenticatedApi, searchText, onSelectAccount, onRefine, compact, style,
  activeIndex, onItems, activateRef,
}: ResourcePickerProps) {
  const toasts = useKumoToastManager()

  const buildRefineUrl = useCallback((suffix: string, replaceSearch?: boolean) => {
    const newUrl = replaceSearch ? suffix : searchText.trim() + suffix
    return newUrl.replace(/\*$/, '')
  }, [searchText])

  const [allAccounts, setAllAccounts] = useState<
    Map<number, { description: AccountDescription, vendor: VendorDescription, supportedResources: SupportedResource[], credentialsValid: boolean }>
  >(new Map())
  const [allVendors, setAllVendors] = useState<VendorOption[]>([])
  const [vendorsLoading, setVendorsLoading] = useState(false)
  const [connectingVendor, setConnectingVendor] = useState<string | null>(null)
  const [reconnectingAccount, setReconnectingAccount] = useState<number | null>(null)

  const subscriptionRef = useRef<{ stub: { [Symbol.dispose](): void } } | null>(null)
  const seenAccountIdsRef = useRef(new Set<number>())

  // Subscribe to connected accounts on mount.
  useEffect(() => {
    seenAccountIdsRef.current = new Set()

    class AccountsSubscriber extends RpcTarget implements ConnenctedAccountsSubscriber {
      add(id: number, description: AccountDescription, vendor: VendorDescription, supportedResources: SupportedResource[] = [], credentialsValid: boolean = true, _vendorId: string = '') {
        seenAccountIdsRef.current.add(id)
        setAllAccounts(prev => {
          const next = new Map(prev)
          next.set(id, { description, vendor, supportedResources, credentialsValid })
          return next
        })
        // Clear reconnecting state if this account was being reconnected and is now valid.
        if (credentialsValid) {
          setReconnectingAccount(prev => prev === id ? null : prev)
        }
      }

      remove(id: number) {
        seenAccountIdsRef.current.delete(id)
        setAllAccounts(prev => {
          const next = new Map(prev)
          next.delete(id)
          return next
        })
      }

      ready() {
        const seen = seenAccountIdsRef.current
        seenAccountIdsRef.current = new Set()
        setAllAccounts(prev => {
          let changed = false
          const next = new Map(prev)
          for (const id of next.keys()) {
            if (!seen.has(id)) {
              next.delete(id)
              changed = true
            }
          }
          return changed ? next : prev
        })
      }
    }

    const subscriber = new AccountsSubscriber()
    const subscribe = async () => {
      try {
        const stub = await authenticatedApi.subscribeConnectedAccounts(subscriber)
        subscriptionRef.current = { stub }
      } catch (error) {
        console.error('Failed to subscribe to connected accounts:', error)
      }
    }
    subscribe()

    return () => {
      if (subscriptionRef.current) {
        subscriptionRef.current.stub[Symbol.dispose]()
        subscriptionRef.current = null
      }
    }
  }, [authenticatedApi])

  // Load all vendors on mount.
  useEffect(() => {
    const loadVendors = async () => {
      setVendorsLoading(true)
      try {
        const vendorList = await authenticatedApi.listGatekeeperVendors()
        setAllVendors(vendorList.map(v => ({
          id: v.id,
          description: v.description,
          supportedResources: v.supportedResources,
        })))
      } catch (error) {
        console.error('Failed to load vendors:', error)
        toasts.add({ title: 'Failed to load available services', variant: 'error' })
      } finally {
        setVendorsLoading(false)
      }
    }
    loadVendors()
  }, [authenticatedApi])

  // --- Filtering and classification logic ---

  const lowerSearch = searchText.toLowerCase().trim()

  const allResourceItems = allVendors.flatMap(v =>
    v.supportedResources.map(r => ({ resource: r, vendor: v }))
  )

  // Check if the search URL still contains placeholder tokens (:name or *).
  const searchHasPlaceholders = lowerSearch ? getPlaceholderRanges(searchText.trim()).length > 0 : false

  type MatchedResource = {
    resource: SupportedResource
    vendor: VendorOption
    classification: 'full' | 'prefix' | 'none'
    suffix?: string
    // When true, the suffix replaces the entire search text (text-only matches)
    // rather than being appended to it (URL prefix matches).
    replaceSearch?: boolean
    accountsOnly?: boolean
  }

  let matchedResources: MatchedResource[] = []

  if (lowerSearch) {
    for (const { resource, vendor } of allResourceItems) {
      if (!matchesResource(searchText, resource)) continue
      const cls = classifyMatch(searchText.trim(), resource.urlPattern)
      if (cls.type === 'none') {
        // Text-only match (name/description matched but URL didn't). In URL-input
        // mode (onRefine), show as a prefix suggestion so selecting it fills in the
        // resource's base URL. Without onRefine, show normally.
        if (onRefine) {
          // Only treat as prefix if it was actually a text match (not a false positive).
          if (!matchesResourceText(searchText, resource)) continue
          const baseUrl = extractBaseUrl(resource.urlPattern)
          const suffix = baseUrl
            ? baseUrl.replace(/^https?:\/\//, '')
            : resource.urlPattern.replace(/^https?:\/\//, '')
          matchedResources.push({
            resource, vendor,
            classification: 'prefix',
            suffix,
            replaceSearch: true,
          })
        } else {
          matchedResources.push({ resource, vendor, classification: 'none' })
        }
        continue
      }
      matchedResources.push({
        resource, vendor,
        classification: cls.type,
        suffix: cls.type === 'prefix' ? cls.suffix : undefined,
      })
    }
  } else {
    // No search text: show all resources. When onRefine is provided (URL input context),
    // show as prefix matches so the user sees completable suggestions rather than accounts.
    matchedResources = allResourceItems.map(({ resource, vendor }) => ({
      resource, vendor,
      classification: onRefine ? 'prefix' as const : 'full' as const,
      suffix: onRefine ? resource.urlPattern : undefined,
    }))
  }

  // Sort: full matches first, prefix second, text-only (none) third.
  // Within each group, sort by URL pattern so less-specific patterns (shorter paths)
  // appear before more-specific ones, grouping related patterns logically.
  const classOrder = { full: 0, prefix: 1, none: 2 }
  matchedResources.sort((a, b) =>
    classOrder[a.classification] - classOrder[b.classification]
    || a.resource.urlPattern.localeCompare(b.resource.urlPattern)
  )

  // HTTP wildcard (`https://*`) shouldn't match when specific resources also match.
  // But connected HTTP accounts whose details match the search should still show.
  const httpItem = matchedResources.find(({ resource }) => resource.urlPattern === 'https://*')
  const hasSpecificMatches = matchedResources.some(({ resource }) => resource.urlPattern !== 'https://*')

  if (lowerSearch && httpItem && hasSpecificMatches) {
    matchedResources = matchedResources.filter(({ resource }) => resource.urlPattern !== 'https://*')

    const httpVendorName = httpItem.vendor.description.displayName
    const httpAccounts = [...allAccounts.entries()]
      .filter(([_, { vendor: v }]) => v.displayName === httpVendorName)

    const hasMatchingAccounts = lowerSearch
      ? httpAccounts.some(([_, { description }]) => {
          const corpus = [description.displayName, description.uniqueName, ...description.scope]
            .filter(Boolean).join(' ').toLowerCase()
          return lowerSearch.split(/\s+/).every(t => corpus.includes(t))
        })
      : httpAccounts.length > 0

    if (hasMatchingAccounts) {
      matchedResources.push({ ...httpItem, accountsOnly: true })
    }
  }

  // --- Build flat list of selectable items for keyboard navigation ---

  const selectableItems = useMemo(() => {
    const items: SelectableItem[] = []
    for (const { resource, vendor, classification, suffix, replaceSearch, accountsOnly } of matchedResources) {
      // Prefix matches: show a single "refine" row (only when onRefine is provided).
      if (classification === 'prefix' && onRefine && suffix) {
        items.push({
          type: 'refine',
          resource,
          vendorDescription: vendor.description,
          suffix,
          replaceSearch,
        })
        continue
      }

      let vendorAccounts = [...allAccounts.entries()]
        .filter(([_, { vendor: v }]) => v.displayName === vendor.description.displayName)
        .map(([id, data]) => ({ id, ...data }))

      if (accountsOnly && lowerSearch) {
        vendorAccounts = vendorAccounts.filter(account => {
          const corpus = [account.description.displayName, account.description.uniqueName, ...account.description.scope]
            .filter(Boolean).join(' ').toLowerCase()
          return lowerSearch.split(/\s+/).every(t => corpus.includes(t))
        })
      }
      if (accountsOnly && vendorAccounts.length === 0) continue

      for (const account of vendorAccounts) {
        items.push({
          type: 'account',
          accountId: account.id,
          vendorId: vendor.id,
          resource,
          accountDescription: account.description,
          vendorDescription: vendor.description,
        })
      }

      // "Connect new account" row (not shown in accountsOnly mode).
      if (!accountsOnly) {
        items.push({
          type: 'connect',
          vendorId: vendor.id,
          vendorDescription: vendor.description,
        })
      }
    }
    return items
  }, [matchedResources, allAccounts, lowerSearch, onRefine])

  useEffect(() => {
    onItems?.(selectableItems)
  }, [selectableItems, onItems])

  // Expose an activate function so the parent can trigger selection by index.
  useEffect(() => {
    if (activateRef) {
      activateRef.current = (index: number) => {
        const item = selectableItems[index]
        if (!item) return
        if (item.type === 'refine') {
          if (onRefine) {
            const newUrl = buildRefineUrl(item.suffix, item.replaceSearch)
            const placeholders = getPlaceholderRanges(newUrl)
            if (placeholders.length > 0) {
              onRefine(newUrl, placeholders[0].start, placeholders[0].end)
            } else {
              onRefine(newUrl, newUrl.length, newUrl.length)
            }
          }
        } else if (item.type === 'account') {
          // Don't allow account activation if the URL still has placeholders.
          if (searchHasPlaceholders) return
          const accountData = allAccounts.get(item.accountId)
          if (accountData && !accountData.credentialsValid) {
            handleReconnect(item.accountId)
          } else {
            onSelectAccount(item.accountId, item.vendorId, item.resource, item.accountDescription, item.vendorDescription)
          }
        } else {
          handleConnectNew(item.vendorId)
        }
      }
      return () => { activateRef.current = null }
    }
  })

  // --- Connect new account handler ---

  const handleConnectNew = async (vendorId: string) => {
    setConnectingVendor(vendorId)
    try {
      const result = await authenticatedApi.connectAccount(vendorId)
      window.open(result.url, '_blank', 'noopener,noreferrer')
    } catch (error) {
      console.error('Failed to initiate connection:', error)
      toasts.add({ title: 'Failed to start connection flow', variant: 'error' })
    } finally {
      setConnectingVendor(null)
    }
  }

  // --- Reconnect expired account handler ---

  const handleReconnect = useCallback(async (accountId: number) => {
    setReconnectingAccount(accountId)
    try {
      const result = await authenticatedApi.reconnectAccount(accountId)
      window.open(result.url, '_blank', 'noopener,noreferrer')
      // The subscription will fire add() with credentialsValid: true when reconnect completes.
      // The reconnectingAccount state is cleared at that point.
    } catch (error) {
      console.error('Failed to initiate reconnection:', error)
      toasts.add({ title: 'Failed to start re-authentication flow', variant: 'error' })
      setReconnectingAccount(null)
    }
  }, [authenticatedApi])

  // --- Render ---

  const maxHeight = compact ? 300 : 400

  return (
    <div style={style}>
      <div className="border border-kumo-line rounded-lg overflow-hidden overflow-y-auto" style={{ maxHeight }}>
        {vendorsLoading ? (
          <div className="text-center py-4">
            <div className="inline-block w-4 h-4 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
          </div>
        ) : matchedResources.length === 0 ? (
          <div className="px-4 py-3">
            <span className="text-kumo-subtle text-sm">No matching resources.</span>
          </div>
        ) : (() => {
          let itemIdx = 0
          return matchedResources.map(({ resource, vendor, classification, suffix, replaceSearch, accountsOnly }, i) => {
            // --- Prefix match: render as a single compact "refine" row ---
            if (classification === 'prefix' && onRefine && suffix) {
              const isActive = itemIdx === activeIndex
              const currentIdx = itemIdx++
              return (
                <div
                  key={`${vendor.id}-${resource.urlPattern}`}
                  onClick={() => {
                    const newUrl = buildRefineUrl(suffix, replaceSearch)
                    const placeholders = getPlaceholderRanges(newUrl)
                    if (placeholders.length > 0) {
                      onRefine(newUrl, placeholders[0].start, placeholders[0].end)
                    } else {
                      onRefine(newUrl, newUrl.length, newUrl.length)
                    }
                  }}
                  className={`px-4 py-1.5 cursor-pointer flex items-center ${i > 0 ? 'border-t border-kumo-line' : ''} ${isActive ? 'bg-kumo-tint' : ''}`}
                  onMouseEnter={e => { if (currentIdx !== activeIndex) e.currentTarget.style.backgroundColor = 'var(--color-kumo-elevated)' }}
                  onMouseLeave={e => { if (currentIdx !== activeIndex) e.currentTarget.style.backgroundColor = '' }}
                >
                  <div className="flex-1 min-w-0">
                    <span className="text-[13px] font-medium text-kumo-default">{resource.title}</span>
                  </div>
                  <span className="text-xs font-mono text-kumo-subtle flex-shrink-0">
                    {resource.urlPattern.replace(/^https?:\/\//, '')}
                  </span>
                </div>
              )
            }

            // --- Full match or no-refine prefix: render with accounts ---
            let vendorAccounts = [...allAccounts.entries()]
              .filter(([_, { vendor: v }]) => v.displayName === vendor.description.displayName)
              .map(([id, data]) => ({ id, ...data }))

            // In accounts-only mode (HTTP alongside specific matches), only show
            // accounts whose details match the search.
            if (accountsOnly && lowerSearch) {
              vendorAccounts = vendorAccounts.filter(account => {
                const corpus = [account.description.displayName, account.description.uniqueName, ...account.description.scope]
                  .filter(Boolean).join(' ').toLowerCase()
                return lowerSearch.split(/\s+/).every(t => corpus.includes(t))
              })
            }

            if (accountsOnly && vendorAccounts.length === 0) return null

            const hostname = extractHostname(resource.urlPattern)

            return (
              <div key={`${vendor.id}-${resource.urlPattern}`} className={i > 0 ? 'border-t border-kumo-line' : ''}>
                {/* Resource header */}
                <div className="px-4 py-2 bg-kumo-elevated">
                  <span className="font-medium text-[13px] text-kumo-default">{resource.title}</span>
                  <span className="text-xs text-kumo-subtle ml-1.5">{resource.description}</span>
                </div>

                {/* Existing account rows */}
                {vendorAccounts.map(account => {
                  const isActive = itemIdx === activeIndex
                  const currentIdx = itemIdx++
                  const isExpired = !account.credentialsValid
                  const isReconnecting = reconnectingAccount === account.id
                  const accountRow = (
                    <div
                      onClick={() => {
                        if (searchHasPlaceholders) return
                        if (isExpired || isReconnecting) {
                          if (!isReconnecting) handleReconnect(account.id)
                        } else {
                          onSelectAccount(account.id, vendor.id, resource, account.description, vendor.description)
                        }
                      }}
                      className={`pl-8 pr-4 py-1.5 flex items-center border-t border-kumo-fill ${isActive ? 'bg-kumo-tint' : ''} ${
                        (isExpired && !isReconnecting) || searchHasPlaceholders ? 'opacity-70' : ''
                      }`}
                      style={{
                        cursor: searchHasPlaceholders ? 'default' : isReconnecting ? 'wait' : 'pointer',
                      }}
                      onMouseEnter={e => { if (currentIdx !== activeIndex) e.currentTarget.style.backgroundColor = 'var(--color-kumo-elevated)' }}
                      onMouseLeave={e => { if (currentIdx !== activeIndex) e.currentTarget.style.backgroundColor = '' }}
                    >
                      <div className="flex-1 min-w-0">
                        <span className="text-[13px] text-kumo-default">
                          {account.description.uniqueName || account.description.displayName}
                        </span>
                        {hostname && hostname !== '*' && (
                          <span className="text-xs text-kumo-subtle ml-1.5">
                            {hostname}
                          </span>
                        )}
                      </div>
                      {isReconnecting ? (
                        <div className="w-3 h-3 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin flex-shrink-0" />
                      ) : isExpired ? (
                        <span className="flex items-center flex-shrink-0 gap-1">
                          <Warning size={12} className="text-kumo-warning" />
                          <span className="text-[11px] text-kumo-warning">Expired — click to re-authenticate</span>
                        </span>
                      ) : (
                        <CaretRight size={10} className="text-kumo-inactive flex-shrink-0" />
                      )}
                    </div>
                  )

                  if (searchHasPlaceholders) {
                    return (
                      <Tooltip key={account.id} content="Replace all placeholders in the URL before selecting an account" asChild>
                        {accountRow}
                      </Tooltip>
                    )
                  }
                  return <div key={account.id}>{accountRow}</div>
                })}

                {/* Connect new account */}
                {(() => {
                  if (accountsOnly) return null
                  const isActive = itemIdx === activeIndex
                  const currentIdx = itemIdx++
                  return (
                  <div
                    onClick={() => !connectingVendor && handleConnectNew(vendor.id)}
                    className={`pl-8 pr-4 py-1.5 flex items-center border-t border-kumo-fill ${isActive ? 'bg-kumo-tint' : ''}`}
                    style={{
                      cursor: connectingVendor === vendor.id ? 'wait' : 'pointer',
                    }}
                    onMouseEnter={e => { if (currentIdx !== activeIndex) e.currentTarget.style.backgroundColor = 'var(--color-kumo-elevated)' }}
                    onMouseLeave={e => { if (currentIdx !== activeIndex) e.currentTarget.style.backgroundColor = '' }}
                  >
                    {connectingVendor === vendor.id ? (
                      <div className="w-3 h-3 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin mr-2" />
                    ) : (
                      <Plus size={11} className="mr-2 text-kumo-subtle" />
                    )}
                    <span className="text-xs text-kumo-subtle">
                      {connectingVendor === vendor.id ? 'Opening...' : 'Connect new account'}
                    </span>
                  </div>
                  )
                })()}
              </div>
            )
          })
        })()}
      </div>
    </div>
  )
}
