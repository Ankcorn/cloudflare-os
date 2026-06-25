import { Link } from '@tanstack/react-router'
import { Hexagon } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi, Overseer, GadgetMetadata } from '@gadgets/workshop-shared/api'
import GadgetUI from './GadgetUI'
import UserMenu from './components/UserMenu'
import { GadgetPresence } from './components/GadgetPresence'
import TopBarNotice from './TopBarNotice'

// The minimal, "use"-only experience: a shared top bar plus the gadget's deployed UI, and nothing
// else. Collaborators with the "use" role may only render and interact with the gadget's mainline
// UI (see UseOverseerInterface in the backend), so we deliberately omit the chat sidebar, the
// Gadget/Code/Connections/Activity tab bar, and every editor-only control. The overseer passed in
// here is the restricted capability returned by openGadget() for "use" sessions; calling anything
// outside getMetadata()/subscribeToMetadata()/subscribeToPresence()/getUiBundle()/connectToGadget()
// would throw.
type Props = {
  overseer: RpcStub<Overseer>
  metadata: GadgetMetadata
  authenticatedApi: RpcStub<AuthenticatedApi>
  currentUserId: string | null
}

// Matches the top bar height used by the full editor (and the home page header).
const TOPBAR_H = 56

export default function GadgetUseView({
  overseer,
  metadata,
  authenticatedApi,
  currentUserId,
}: Props) {
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-kumo-base relative">
      {/* ═══ TOP BAR ════════════════════════════════════════════════════════════ */}
      <div
        className="relative flex items-center justify-between px-4 sm:px-6 backdrop-blur-md border-b border-kumo-line flex-shrink-0 gap-3"
        style={{ height: TOPBAR_H, backgroundColor: 'color-mix(in srgb, var(--color-kumo-base) 80%, transparent)' }}
      >
        <TopBarNotice />
        {/* Left: logo / title */}
        <div className="flex items-center gap-2 min-w-0">
          <Link to="/" className="flex-shrink-0 hover:opacity-80 transition-opacity">
            <Hexagon size={22} className="text-kumo-brand" weight="bold" />
          </Link>

          <span className="text-kumo-inactive flex-shrink-0">/</span>

          <span className="text-[14px] leading-5 font-medium tracking-[-0.25px] text-kumo-default truncate">
            {metadata.title}
          </span>

          {metadata.owner && (
            <span className="text-xs text-kumo-inactive flex-shrink-0">
              by {metadata.owner.name}
            </span>
          )}
        </div>

        {/* Right: presence and user menu */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <GadgetPresence
            overseer={overseer}
            authenticatedApi={authenticatedApi}
            currentUserId={currentUserId}
          />
          <div className="ml-2">
            <UserMenu />
          </div>
        </div>
      </div>

      {/* ═══ GADGET UI ══════════════════════════════════════════════════════════ */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <GadgetUI
          overseer={overseer}
          height={`calc(100vh - ${TOPBAR_H}px)`}
          isVisible={true}
        />
      </div>
    </div>
  )
}
