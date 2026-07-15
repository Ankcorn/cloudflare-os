import { useState, useEffect, useRef } from 'react'
import { Dialog, Select, Loader, Text, useKumoToastManager } from '@cloudflare/kumo'
import { Warning, Plus, ArrowClockwise } from '@phosphor-icons/react'
import { RpcStub, RpcTarget } from 'capnweb'
import {
  AuthenticatedApi,
  ConnectedAccountsSubscriber,
  ObserverBindingNeed,
  ObserverAccountChoice,
} from '@gadgets/workshop-shared/api'
import { AccountDescription, VendorDescription, SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { WorkshopButton } from './components/WorkshopControls'
import Avatar from './components/Avatar'

// Shown when a non-owner opens a shared Gadget that reads data through one or more gatekeeper
// bindings, and they haven't yet chosen which of their own connected accounts to use for each one.
// Each chosen account's owner is verified (server-side, via the gatekeeper) to actually have access
// to the data the Gadget read — that's how we uphold the "observers can't see data they couldn't
// otherwise read" invariant. See observers-implementation-plan.md §5 Step 4.
//
// The overseer invokes ObserverConfigCallback.configure(needs) during openGadget(); this modal is
// what fulfills that call. Resolving with one ObserverAccountChoice per need lets the open proceed;
// cancelling rejects it (the open is denied and the caller shows an access-denied page).

interface AccountInfo {
  id: number
  description: AccountDescription
  vendor: VendorDescription
  vendorId: string
  credentialsValid: boolean
}

interface ObserverConfigModalProps {
  needs: ObserverBindingNeed[]
  authenticatedApi: RpcStub<AuthenticatedApi>
  onConfirm: (choices: ObserverAccountChoice[]) => void
  onCancel: () => void
}

export default function ObserverConfigModal({
  needs,
  authenticatedApi,
  onConfirm,
  onCancel,
}: ObserverConfigModalProps) {
  const toasts = useKumoToastManager()

  const [accounts, setAccounts] = useState<Map<number, AccountInfo>>(new Map())
  const [ready, setReady] = useState(false)
  // gatekeeperId -> chosen accountId (undefined = not yet chosen).
  const [choices, setChoices] = useState<Record<number, number | undefined>>({})
  // Vendor descriptions keyed by vendorId, for display (name + logo) even when no account exists.
  const [vendorsById, setVendorsById] = useState<Map<string, VendorDescription>>(new Map())
  const [connecting, setConnecting] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState<number | null>(null)

  // The subscriber closure (created once) reads the in-flight connect target through this ref so it
  // can clear it when the freshly-connected account arrives.
  const connectingRef = useRef<string | null>(null)

  // ── subscribe to the user's connected accounts ────────────────────────────────
  useEffect(() => {
    let subStub: { [Symbol.dispose](): void } | null = null
    let cancelled = false

    class Subscriber extends RpcTarget implements ConnectedAccountsSubscriber {
      add(
        id: number,
        description: AccountDescription,
        vendor: VendorDescription,
        _supportedResources: SupportedResource[] = [],
        credentialsValid: boolean = true,
        vendorId: string = '',
      ) {
        setAccounts(prev => {
          const next = new Map(prev)
          next.set(id, { id, description, vendor, vendorId, credentialsValid })
          return next
        })
        if (credentialsValid) {
          setReconnecting(r => (r === id ? null : r))
          // If we were waiting on a connect for this vendor, it's done.
          if (connectingRef.current === vendorId) {
            connectingRef.current = null
            setConnecting(null)
          }
        }
      }

      remove(id: number) {
        setAccounts(prev => {
          if (!prev.has(id)) return prev
          const next = new Map(prev)
          next.delete(id)
          return next
        })
      }

      ready() {
        setReady(true)
      }
    }

    authenticatedApi
      .subscribeConnectedAccounts(new Subscriber())
      .then(stub => {
        if (cancelled) { stub[Symbol.dispose](); return }
        subStub = stub
      })
      .catch(err => {
        console.error('Failed to subscribe to connected accounts:', err)
        toasts.add({ title: 'Failed to load your connected accounts', variant: 'error' })
      })

    return () => {
      cancelled = true
      subStub?.[Symbol.dispose]()
    }
  }, [authenticatedApi])

  // ── load vendor descriptions for display (names + logos) ──────────────────────
  useEffect(() => {
    let cancelled = false
    authenticatedApi
      .listGatekeeperVendors()
      .then(list => {
        if (cancelled) return
        const map = new Map<string, VendorDescription>()
        for (const v of list) map.set(v.id, v.description)
        setVendorsById(map)
      })
      .catch(err => console.error('Failed to load vendors:', err))
    return () => { cancelled = true }
  }, [authenticatedApi])

  // ── keep choices in sync with the available accounts ──────────────────────────
  // Default each binding to its first matching account, and drop a choice whose account has
  // disappeared (e.g. disconnected in another tab).
  useEffect(() => {
    setChoices(prev => {
      let changed = false
      const next = { ...prev }
      for (const need of needs) {
        const matching = [...accounts.values()].filter(a => a.vendorId === need.vendorId)
        const current = next[need.gatekeeperId]
        if (current !== undefined && !accounts.has(current)) {
          next[need.gatekeeperId] = matching[0]?.id
          changed = true
        } else if (current === undefined && matching.length > 0) {
          next[need.gatekeeperId] = matching[0].id
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [accounts, needs])

  // ── connect / reconnect handlers ──────────────────────────────────────────────
  const handleConnect = async (vendorId: string) => {
    connectingRef.current = vendorId
    setConnecting(vendorId)
    try {
      const { url } = await authenticatedApi.connectAccount(vendorId)
      window.open(url, '_blank', 'noopener,noreferrer')
      // The subscription fires add() with the new account when the flow completes, at which point
      // we clear `connecting` and auto-select it via the default-choice effect above.
    } catch (err) {
      console.error('Failed to initiate connection:', err)
      toasts.add({ title: 'Failed to start connection flow', variant: 'error' })
      connectingRef.current = null
      setConnecting(null)
    }
  }

  const handleReconnect = async (accountId: number) => {
    setReconnecting(accountId)
    try {
      const { url } = await authenticatedApi.reconnectAccount(accountId)
      window.open(url, '_blank', 'noopener,noreferrer')
      // Subscription fires add() with credentialsValid:true on completion, clearing `reconnecting`.
    } catch (err) {
      console.error('Failed to initiate reconnection:', err)
      toasts.add({ title: 'Failed to start re-authentication flow', variant: 'error' })
      setReconnecting(null)
    }
  }

  // A binding is satisfied only when its chosen account exists and its credentials are valid.
  const accountFor = (gatekeeperId: number): AccountInfo | undefined => {
    const id = choices[gatekeeperId]
    return id === undefined ? undefined : accounts.get(id)
  }
  const allSatisfied = needs.every(n => accountFor(n.gatekeeperId)?.credentialsValid)

  const handleConfirm = () => {
    const result: ObserverAccountChoice[] = []
    for (const need of needs) {
      const accountId = choices[need.gatekeeperId]
      if (accountId === undefined) return
      result.push({ gatekeeperId: need.gatekeeperId, accountId })
    }
    onConfirm(result)
  }

  return (
    <Dialog.Root open disablePointerDismissal onOpenChange={open => { if (!open) onCancel() }}>
      <Dialog className="p-6" size="lg">
        <Dialog.Title className="text-lg font-semibold mb-2">Confirm access</Dialog.Title>
        <Text variant="secondary" size="sm" as="p">
          To open this Gadget, choose which of your accounts to use for each service it relies on,
          so we can confirm you&apos;re allowed to see the data it uses.
        </Text>

        {!ready ? (
          <div className="text-center py-10">
            <Loader />
          </div>
        ) : (
          <div className="flex flex-col gap-4 mt-5">
            {needs.map(need => {
              const vendor = vendorsById.get(need.vendorId)
              const vendorName = vendor?.displayName || need.vendorId || 'service'
              const matching = [...accounts.values()].filter(a => a.vendorId === need.vendorId)
              const chosen = accountFor(need.gatekeeperId)

              return (
                <div key={need.gatekeeperId} className="border border-kumo-line rounded-lg p-4">
                  <div className={`flex items-center gap-3${matching.length === 0 ? '' : ' mb-3'}`}>
                    <Avatar src={vendor?.logo?.url} size={32} fallback={<Plus size={16} />} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium text-kumo-default truncate">
                        {need.resourceTitle}
                      </div>
                      {need.resourceUrl && (
                        <div className="text-xs font-mono text-kumo-subtle truncate">
                          {need.resourceUrl.replace(/^https?:\/\//, '')}
                        </div>
                      )}
                    </div>
                    {matching.length === 0 && (
                      <WorkshopButton
                        tone="primary"
                        onClick={() => handleConnect(need.vendorId)}
                        disabled={connecting === need.vendorId}
                      >
                        {connecting === need.vendorId ? 'Waiting for connection…' : 'Connect'}
                      </WorkshopButton>
                    )}
                  </div>

                  {matching.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <Select
                        className="w-full text-sm"
                        value={
                          choices[need.gatekeeperId] !== undefined
                            ? String(choices[need.gatekeeperId])
                            : undefined
                        }
                        placeholder={`Choose a ${vendorName} account…`}
                        onValueChange={v =>
                          setChoices(prev => ({ ...prev, [need.gatekeeperId]: Number(v) }))
                        }
                        renderValue={v => {
                          const acct = accounts.get(Number(v))
                          return acct?.description.uniqueName || acct?.description.displayName || String(v)
                        }}
                      >
                        {matching.map(acct => (
                          <Select.Option key={acct.id} value={String(acct.id)}>
                            {acct.description.uniqueName || acct.description.displayName || `Account ${acct.id}`}
                            {!acct.credentialsValid ? ' (expired)' : ''}
                          </Select.Option>
                        ))}
                      </Select>

                      {chosen && !chosen.credentialsValid && (
                        <button
                          type="button"
                          onClick={() => handleReconnect(chosen.id)}
                          disabled={reconnecting === chosen.id}
                          className="flex items-center gap-1.5 text-xs text-kumo-warning hover:underline disabled:opacity-60"
                        >
                          {reconnecting === chosen.id ? (
                            <ArrowClockwise size={12} className="animate-spin" />
                          ) : (
                            <Warning size={12} />
                          )}
                          {reconnecting === chosen.id
                            ? 'Re-authenticating…'
                            : 'This account has expired — click to re-authenticate'}
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => handleConnect(need.vendorId)}
                        disabled={connecting === need.vendorId}
                        className="flex items-center gap-1 text-xs text-kumo-subtle hover:text-kumo-default disabled:opacity-60 self-start"
                      >
                        <Plus size={11} />
                        {connecting === need.vendorId ? 'Waiting for connection…' : 'Connect a different account'}
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-6">
          <WorkshopButton tone="secondary" onClick={onCancel}>
            Cancel
          </WorkshopButton>
          <WorkshopButton tone="primary" onClick={handleConfirm} disabled={!ready || !allSatisfied}>
            Open Gadget
          </WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
