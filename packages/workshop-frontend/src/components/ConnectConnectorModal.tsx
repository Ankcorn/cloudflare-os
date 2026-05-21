import { Dialog } from '@cloudflare/kumo'
import {
  X,
  CaretDown,
  CaretRight,
  ShieldCheck,
  Check,
} from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import {
  AccountDescription,
  SupportedResource,
  VendorDescription,
  VendorScope,
} from '@gadgets/workshop-shared/gatekeeper'
import { WorkshopButton, WorkshopIconButton } from './WorkshopControls'

interface ConnectConnectorModalProps {
  open: boolean
  mode: 'connect' | 'manage'
  vendorDescription: VendorDescription
  supportedResources: SupportedResource[]
  scopeCatalog: VendorScope[]
  loadingCatalog: boolean
  catalogError?: string | null
  logoUrl?: string
  color?: string
  onOpenChange: (open: boolean) => void
  onRetryCatalog?: () => void
  connecting?: boolean
  onConfirm?: () => void
  accountDescription?: AccountDescription
  credentialsValid?: boolean
  disconnecting?: boolean
  onDisconnect?: () => void
}

function PermissionStatusIcon() {
  return (
    <span
      className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-[rgba(42,142,58,0.12)] text-[#1f6e2c]"
      aria-hidden
    >
      <Check size={10} weight="bold" />
    </span>
  )
}

export default function ConnectConnectorModal({
  open,
  mode,
  vendorDescription,
  supportedResources,
  scopeCatalog,
  loadingCatalog,
  catalogError = null,
  logoUrl,
  color,
  onOpenChange,
  onRetryCatalog,
  connecting = false,
  onConfirm,
  accountDescription,
  credentialsValid = true,
  disconnecting = false,
  onDisconnect,
}: ConnectConnectorModalProps) {
  const isManage = mode === 'manage'

  const [advancedOpen, setAdvancedOpen] = useState(isManage)
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)

  useEffect(() => {
    if (!open) return
    if (isManage) {
      setAdvancedOpen(true)
    } else {
      setAdvancedOpen(false)
    }
    setConfirmingDisconnect(false)
  }, [open, isManage])

  const hasScopes = scopeCatalog.length > 0
  const permissionSummary = `${scopeCatalog.length} permission${
    scopeCatalog.length === 1 ? '' : 's'
  } ${isManage ? 'granted' : 'requested'}`

  function handleConfirm() {
    if (!onConfirm) return
    onConfirm()
  }

  function handleDisconnect() {
    if (!confirmingDisconnect) {
      setConfirmingDisconnect(true)
      return
    }
    onDisconnect?.()
  }

  const accountDisplayName =
    accountDescription?.displayName ??
    accountDescription?.uniqueName ??
    'Connected'

  const headerTitle = isManage
    ? vendorDescription.displayName
    : `Connect ${vendorDescription.displayName}`

  const headerSubline = isManage ? (
    <div className="mt-0.5 flex items-center gap-1.5 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          credentialsValid ? 'bg-[#2a8e3a]' : 'bg-kumo-danger'
        }`}
        aria-hidden
      />
      <span className="truncate">
        {credentialsValid
          ? accountDescription?.uniqueName
            ? `${accountDisplayName} / ${accountDescription.uniqueName}`
            : accountDisplayName
          : 'Credentials expired; reconnect from the Gatekeepers page'}
      </span>
    </div>
  ) : (
    vendorDescription.tagline && (
      <Dialog.Description className="mt-0.5 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
        {vendorDescription.tagline}
      </Dialog.Description>
    )
  )

  const busy = connecting || disconnecting
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (busy) return
        onOpenChange(nextOpen)
      }}
    >
      <Dialog
        className="!z-[1000] !top-[clamp(28px,8vh,80px)] !flex !max-h-[calc(100vh-clamp(28px,8vh,80px)-28px)] !w-[min(640px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0"
        size="lg"
      >
        <div className="shrink-0 flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
              style={{ backgroundColor: color ?? 'var(--color-kumo-tint)' }}
            >
              {logoUrl ? (
                <img src={logoUrl} alt="" className="h-5 w-5 object-contain" />
              ) : (
                <span className="text-sm font-semibold text-kumo-strong">
                  {vendorDescription.displayName[0]}
                </span>
              )}
            </div>
            <div className="min-w-0">
              <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
                {headerTitle}
              </Dialog.Title>
              {headerSubline}
            </div>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton {...props} disabled={busy} aria-label="Close">
                <X size={16} />
              </WorkshopIconButton>
            )}
          />
        </div>

        <div className="new-gatekeeper-scroll-balanced min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {vendorDescription.description && (
            <p className="text-[13px] leading-[19px] font-normal tracking-[-0.25px] text-kumo-default">
              {vendorDescription.description}
            </p>
          )}

          {supportedResources.length > 0 && (
            <div className="mt-5">
              <h3 className="text-[12px] leading-4 font-semibold uppercase tracking-[0.6px] text-kumo-inactive">
                What this gatekeeper can do
              </h3>
              <ul className="mt-2 space-y-2">
                {supportedResources.map((resource) => {
                  return (
                    <li
                      key={resource.urlPattern}
                      className="flex items-start gap-3 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2.5"
                    >
                      <div
                        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-kumo-strong"
                        style={{ backgroundColor: 'var(--color-kumo-tint)' }}
                      >
                        {resource.icon ? (
                          <img
                            src={resource.icon.url}
                            alt=""
                            className="h-4 w-4 object-contain"
                          />
                        ) : logoUrl ? (
                          <img src={logoUrl} alt="" className="h-4 w-4 object-contain" />
                        ) : (
                          <ResourceIconGlyph />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                            {resource.title}
                          </p>
                        </div>
                        <p className="mt-0.5 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                          {resource.description}
                        </p>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {!isManage && (
            <div
              className="relative mt-5 overflow-hidden rounded-lg border border-kumo-line px-4 py-3"
              style={{
                background:
                  'linear-gradient(180deg, rgba(255, 72, 1, 0.04) 0%, rgba(255, 72, 1, 0.02) 100%)',
              }}
            >
              <div className="flex items-start gap-3">
                <ShieldCheck
                  size={18}
                  className="mt-0.5 shrink-0 text-kumo-brand"
                  weight="duotone"
                />
                <div className="text-[12px] leading-[17px] font-normal tracking-[-0.2px] text-kumo-default">
                  <span className="font-medium">
                    Gatekeeper sits between {vendorDescription.displayName} and your Gadgets.
                  </span>{' '}
                  <span className="text-kumo-subtle">
                    Each Gadget only sees the resources you connect. If the Gadget is shared,
                    Gatekeeper verifies other users have the required permissions before they can
                    access those resources.
                  </span>
                </div>
              </div>
            </div>
          )}

          {isManage && (
            <div className="mt-5 rounded-lg border border-kumo-line bg-kumo-elevated px-4 py-3 text-[12px] leading-[17px] font-normal tracking-[-0.2px] text-kumo-subtle">
              This account can be used by Gadgets you connect it to. Shared users must have the
              required permissions before they can access those connected resources.
            </div>
          )}

          {hasScopes ? (
            <div className="mt-5">
              {isManage ? (
                <div className="mb-3 flex items-baseline justify-between gap-2 px-1">
                  <h3 className="m-0 text-[12px] leading-4 font-semibold uppercase tracking-[0.6px] text-kumo-inactive">
                    Permissions you granted
                  </h3>
                  <p className="text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                    {permissionSummary}
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((v) => !v)}
                  className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2.5 text-left transition-colors hover:bg-kumo-elevated"
                >
                  <div className="min-w-0">
                    <p className="text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                      Permission details
                    </p>
                    <p className="mt-0.5 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                      {advancedOpen
                        ? permissionSummary
                        : `${permissionSummary}. Expand to review.`}
                    </p>
                  </div>
                  {advancedOpen ? (
                    <CaretDown size={14} className="shrink-0 text-kumo-subtle" />
                  ) : (
                    <CaretRight size={14} className="shrink-0 text-kumo-subtle" />
                  )}
                </button>
              )}

              {advancedOpen && (
                <div
                  className={`overflow-hidden rounded-lg border border-kumo-line bg-kumo-base ${
                    isManage ? '' : 'mt-3'
                  }`}
                >
                  {scopeCatalog.map((scope, idx) => (
                    <div
                      key={`${scope.displayName}:${idx}`}
                      className={`flex cursor-default items-start gap-3 px-3 py-3 ${
                        idx > 0 ? 'border-t border-kumo-line' : ''
                      }`}
                    >
                      <PermissionStatusIcon />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                            {scope.displayName}
                          </p>
                        </div>
                        <p className="mt-0.5 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                          {scope.rationale}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : loadingCatalog ? (
            <div className="mt-5 rounded-lg border border-kumo-line bg-kumo-base px-3 py-3 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              Loading permissions...
            </div>
          ) : catalogError ? (
            <div className="mt-5 rounded-lg border border-kumo-line bg-kumo-base px-3 py-3">
              <p className="text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-default">
                Could not load permissions.
              </p>
              <p className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                Retry before continuing so the OAuth request matches what this gatekeeper discloses.
              </p>
              {onRetryCatalog && (
                <WorkshopButton className="mt-3" onClick={onRetryCatalog}>
                  Retry
                </WorkshopButton>
              )}
            </div>
          ) : null}
        </div>

        <div className="shrink-0 flex items-center justify-between gap-3 border-t border-kumo-line bg-kumo-base px-5 py-3">
          {isManage && confirmingDisconnect ? (
            <p className="m-0 min-w-0 flex-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-default">
              Disconnect {vendorDescription.displayName}? Gadgets using this will lose access.
            </p>
          ) : (
            <span aria-hidden />
          )}
          <div className="flex items-center gap-2">
            {isManage ? (
              <>
                {confirmingDisconnect ? (
                  <>
                    <WorkshopButton
                      onClick={() => setConfirmingDisconnect(false)}
                      disabled={disconnecting}
                    >
                      Cancel
                    </WorkshopButton>
                    <WorkshopButton
                      tone="danger"
                      onClick={handleDisconnect}
                      disabled={disconnecting}
                      className="min-w-[140px]"
                    >
                      {disconnecting ? 'Disconnecting...' : 'Yes, disconnect'}
                    </WorkshopButton>
                  </>
                ) : (
                  <>
                    <Dialog.Close
                      render={(props) => <WorkshopButton {...props}>Close</WorkshopButton>}
                    />
                    <WorkshopButton
                      tone="danger"
                      onClick={handleDisconnect}
                      disabled={disconnecting}
                    >
                      Disconnect
                    </WorkshopButton>
                  </>
                )}
              </>
            ) : (
              <>
                <Dialog.Close
                  render={(props) => (
                    <WorkshopButton {...props} disabled={connecting}>
                      Cancel
                    </WorkshopButton>
                  )}
                />
                <WorkshopButton
                  tone="primary"
                  onClick={handleConfirm}
                  disabled={
                    connecting ||
                    loadingCatalog ||
                    !!catalogError
                  }
                  className="min-w-[140px]"
                >
                  {connecting
                    ? 'Opening...'
                    : loadingCatalog
                    ? 'Loading...'
                    : `Continue to ${vendorDescription.displayName}`}
                </WorkshopButton>
              </>
            )}
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}

function ResourceIconGlyph() {
  const size = 14
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="8" />
    </svg>
  )
}
