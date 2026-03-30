import { useState, useEffect, useRef, useMemo, useCallback, type MutableRefObject } from 'react'
import { Typography, Spin, message } from 'antd'
import { PlusOutlined, RightOutlined, WarningOutlined } from '@ant-design/icons'
import { RpcStub, RpcTarget } from 'capnweb'
import { AuthenticatedApi, ConnenctedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { extractHostname, matchesResource, classifyMatch, getPlaceholderRanges } from './resourceMatching'

const { Text } = Typography

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
      add(id: number, description: AccountDescription, vendor: VendorDescription, supportedResources: SupportedResource[] = [], credentialsValid: boolean = true) {
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
        message.error('Failed to load available services')
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
    accountsOnly?: boolean
  }

  let matchedResources: MatchedResource[] = []

  if (lowerSearch) {
    for (const { resource, vendor } of allResourceItems) {
      if (!matchesResource(searchText, resource)) continue
      const cls = classifyMatch(searchText.trim(), resource.urlPattern)
      // When onRefine is provided, only show full and prefix matches — suppress
      // text-only matches (none) since they have no useful URL suffix.
      if (cls.type === 'none' && onRefine) continue
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
    for (const { resource, vendor, classification, suffix, accountsOnly } of matchedResources) {
      // Prefix matches: show a single "refine" row (only when onRefine is provided).
      if (classification === 'prefix' && onRefine && suffix) {
        items.push({
          type: 'refine',
          resource,
          vendorDescription: vendor.description,
          suffix,
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
            const newUrl = searchText.trim() + item.suffix
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
      window.open(result.url, '_blank')
    } catch (error) {
      console.error('Failed to initiate connection:', error)
      message.error('Failed to start connection flow')
    } finally {
      setConnectingVendor(null)
    }
  }

  // --- Reconnect expired account handler ---

  const handleReconnect = useCallback(async (accountId: number) => {
    setReconnectingAccount(accountId)
    try {
      const result = await authenticatedApi.reconnectAccount(accountId)
      window.open(result.url, '_blank')
      // The subscription will fire add() with credentialsValid: true when reconnect completes.
      // The reconnectingAccount state is cleared at that point.
    } catch (error) {
      console.error('Failed to initiate reconnection:', error)
      message.error('Failed to start re-authentication flow')
      setReconnectingAccount(null)
    }
  }, [authenticatedApi])

  // --- Render ---

  const maxHeight = compact ? 300 : 400

  return (
    <div style={style}>
      <div style={{
        border: '1px solid #e8e8e8',
        borderRadius: 8,
        overflow: 'hidden',
        maxHeight,
        overflowY: 'auto',
      }}>
        {vendorsLoading ? (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <Spin size="small" />
          </div>
        ) : matchedResources.length === 0 ? (
          <div style={{ padding: '12px 16px' }}>
            <Text type="secondary">No matching resources.</Text>
          </div>
        ) : (() => {
          let itemIdx = 0
          return matchedResources.map(({ resource, vendor, classification, suffix, accountsOnly }, i) => {
            // --- Prefix match: render as a single compact "refine" row ---
            if (classification === 'prefix' && onRefine && suffix) {
              const isActive = itemIdx === activeIndex
              const currentIdx = itemIdx++
              return (
                <div
                  key={`${vendor.id}-${resource.urlPattern}`}
                  onClick={() => {
                    const newUrl = searchText.trim() + suffix
                    const placeholders = getPlaceholderRanges(newUrl)
                    if (placeholders.length > 0) {
                      onRefine(newUrl, placeholders[0].start, placeholders[0].end)
                    } else {
                      onRefine(newUrl, newUrl.length, newUrl.length)
                    }
                  }}
                  style={{
                    padding: '6px 16px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    borderTop: i > 0 ? '1px solid #e8e8e8' : undefined,
                    backgroundColor: isActive ? '#e6f4ff' : undefined,
                  }}
                  onMouseEnter={e => { if (currentIdx !== activeIndex) e.currentTarget.style.backgroundColor = '#f0f0f0' }}
                  onMouseLeave={e => { if (currentIdx !== activeIndex) e.currentTarget.style.backgroundColor = '' }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text style={{ fontSize: 13, fontWeight: 500 }}>{resource.title}</Text>
                  </div>
                  <Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace', flexShrink: 0 }}>
                    {resource.urlPattern.replace(/^https?:\/\//, '')}
                  </Text>
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
              <div key={`${vendor.id}-${resource.urlPattern}`} style={{ borderTop: i > 0 ? '1px solid #e8e8e8' : undefined }}>
                {/* Resource header */}
                <div style={{
                  padding: '8px 16px',
                  backgroundColor: '#fafafa',
                }}>
                  <span style={{ fontWeight: 500, fontSize: 13 }}>{resource.title}</span>
                  <span style={{ color: '#8c8c8c', fontSize: 12, marginLeft: 6 }}>{resource.description}</span>
                </div>

                {/* Existing account rows */}
                {vendorAccounts.map(account => {
                  const isActive = itemIdx === activeIndex
                  const currentIdx = itemIdx++
                  const isExpired = !account.credentialsValid
                  const isReconnecting = reconnectingAccount === account.id
                  return (
                    <div
                      key={account.id}
                      onClick={() => {
                        if (searchHasPlaceholders) return
                        if (isExpired || isReconnecting) {
                          if (!isReconnecting) handleReconnect(account.id)
                        } else {
                          onSelectAccount(account.id, vendor.id, resource, account.description, vendor.description)
                        }
                      }}
                      style={{
                        padding: '6px 16px 6px 32px',
                        cursor: searchHasPlaceholders ? 'default' : isReconnecting ? 'wait' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        borderTop: '1px solid #f5f5f5',
                        backgroundColor: isActive ? '#e6f4ff' : undefined,
                        opacity: (isExpired && !isReconnecting) || searchHasPlaceholders ? 0.7 : undefined,
                      }}
                      onMouseEnter={e => { if (currentIdx !== activeIndex) e.currentTarget.style.backgroundColor = '#f0f0f0' }}
                      onMouseLeave={e => { if (currentIdx !== activeIndex) e.currentTarget.style.backgroundColor = '' }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: 13 }}>
                          {account.description.uniqueName || account.description.displayName}
                        </Text>
                        {hostname && hostname !== '*' && (
                          <Text type="secondary" style={{ fontSize: 12, marginLeft: 6 }}>
                            {hostname}
                          </Text>
                        )}
                      </div>
                      {isReconnecting ? (
                        <Spin size="small" style={{ flexShrink: 0 }} />
                      ) : isExpired ? (
                        <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0, gap: 4 }}>
                          <WarningOutlined style={{ color: '#faad14', fontSize: 12 }} />
                          <Text type="warning" style={{ fontSize: 11 }}>Expired — click to re-authenticate</Text>
                        </span>
                      ) : (
                        <RightOutlined style={{ color: '#bfbfbf', fontSize: 10, flexShrink: 0 }} />
                      )}
                    </div>
                  )
                })}

                {/* Connect new account */}
                {(() => {
                  if (accountsOnly) return null
                  const isActive = itemIdx === activeIndex
                  const currentIdx = itemIdx++
                  return (
                  <div
                    onClick={() => !connectingVendor && handleConnectNew(vendor.id)}
                    style={{
                      padding: '6px 16px 6px 32px',
                      cursor: connectingVendor === vendor.id ? 'wait' : 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      borderTop: '1px solid #f5f5f5',
                      backgroundColor: isActive ? '#e6f4ff' : undefined,
                    }}
                    onMouseEnter={e => { if (currentIdx !== activeIndex) e.currentTarget.style.backgroundColor = '#fafafa' }}
                    onMouseLeave={e => { if (currentIdx !== activeIndex) e.currentTarget.style.backgroundColor = '' }}
                  >
                    {connectingVendor === vendor.id ? (
                      <Spin size="small" style={{ marginRight: 8 }} />
                    ) : (
                      <PlusOutlined style={{ marginRight: 8, color: '#8c8c8c', fontSize: 11 }} />
                    )}
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {connectingVendor === vendor.id ? 'Opening...' : 'Connect new account'}
                    </Text>
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
