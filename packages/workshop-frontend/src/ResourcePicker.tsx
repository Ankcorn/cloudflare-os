import { useState, useEffect, useRef, useMemo, type MutableRefObject } from 'react'
import { Typography, Spin, message } from 'antd'
import { PlusOutlined, RightOutlined } from '@ant-design/icons'
import { RpcStub, RpcTarget } from 'capnweb'
import { AuthenticatedApi, ConnenctedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { extractHostname, matchesResource } from './resourceMatching'

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
  compact?: boolean
  style?: React.CSSProperties
  activeIndex?: number
  onItems?: (items: SelectableItem[]) => void
  activateRef?: MutableRefObject<((index: number) => void) | null>
}

export default function ResourcePicker({
  authenticatedApi, searchText, onSelectAccount, compact, style,
  activeIndex, onItems, activateRef,
}: ResourcePickerProps) {
  const [allAccounts, setAllAccounts] = useState<
    Map<number, { description: AccountDescription, vendor: VendorDescription, supportedResources: SupportedResource[] }>
  >(new Map())
  const [allVendors, setAllVendors] = useState<VendorOption[]>([])
  const [vendorsLoading, setVendorsLoading] = useState(false)
  const [connectingVendor, setConnectingVendor] = useState<string | null>(null)

  const subscriptionRef = useRef<{ stub: { [Symbol.dispose](): void } } | null>(null)
  const seenAccountIdsRef = useRef(new Set<number>())

  // Subscribe to connected accounts on mount.
  useEffect(() => {
    seenAccountIdsRef.current = new Set()

    class AccountsSubscriber extends RpcTarget implements ConnenctedAccountsSubscriber {
      add(id: number, description: AccountDescription, vendor: VendorDescription, supportedResources: SupportedResource[] = []) {
        seenAccountIdsRef.current.add(id)
        setAllAccounts(prev => {
          const next = new Map(prev)
          next.set(id, { description, vendor, supportedResources })
          return next
        })
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

  // --- Filtering logic ---

  const lowerSearch = searchText.toLowerCase().trim()

  const allResourceItems = allVendors.flatMap(v =>
    v.supportedResources.map(r => ({ resource: r, vendor: v }))
  )

  let matchedResources: { resource: SupportedResource, vendor: VendorOption, accountsOnly?: boolean }[] =
    lowerSearch
      ? allResourceItems.filter(({ resource }) => matchesResource(searchText, resource))
      : [...allResourceItems]

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
    for (const { resource, vendor, accountsOnly } of matchedResources) {
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
  }, [matchedResources, allAccounts, lowerSearch])

  useEffect(() => {
    onItems?.(selectableItems)
  }, [selectableItems, onItems])

  // Expose an activate function so the parent can trigger selection by index.
  useEffect(() => {
    if (activateRef) {
      activateRef.current = (index: number) => {
        const item = selectableItems[index]
        if (!item) return
        if (item.type === 'account') {
          onSelectAccount(item.accountId, item.vendorId, item.resource, item.accountDescription, item.vendorDescription)
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
          return matchedResources.map(({ resource, vendor, accountsOnly }, i) => {
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
                  return (
                    <div
                      key={account.id}
                      onClick={() => onSelectAccount(account.id, vendor.id, resource, account.description, vendor.description)}
                      style={{
                        padding: '6px 16px 6px 32px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        borderTop: '1px solid #f5f5f5',
                        backgroundColor: isActive ? '#e6f4ff' : undefined,
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
                      <RightOutlined style={{ color: '#bfbfbf', fontSize: 10, flexShrink: 0 }} />
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
