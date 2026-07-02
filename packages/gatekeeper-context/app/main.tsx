// Entrypoint for the sandboxed Context Library iframe. All data flows through the host-injected
// ContextApi RPC capability.

import { createRoot } from 'react-dom/client'
import { TooltipProvider, Toasty } from '@cloudflare/kumo'
import { RpcTarget, newMessagePortRpcSession } from 'capnweb'
import type { RpcStub } from 'capnweb'
import type { ContextApi } from '../src/context-types'
import ContextLibraryPage from './ContextLibraryPage'
import { ContextApiProvider } from './bridge'
import './styles.css'

// The iframe exposes no capabilities back to the host.
class AppIframe extends RpcTarget {}

interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<ContextApi>
}

function main() {
  const root = document.getElementById('root')
  if (!root) throw new Error('missing #root')

  const { port1, port2 } = new MessageChannel()
  // Opaque-origin iframes can't name their parent origin. The parent accepts this handshake only from
  // this frame + null origin; the message only transfers a private port.
  window.parent.postMessage({ type: 'handshake' }, '*', [port2])
  const host = newMessagePortRpcSession<HostCapability>(port1, new AppIframe())

  createRoot(root).render(
    <ContextApiProvider value={host.ui}>
      <TooltipProvider>
        <Toasty>
          <ContextLibraryPage />
        </Toasty>
      </TooltipProvider>
    </ContextApiProvider>,
  )
}

main()
