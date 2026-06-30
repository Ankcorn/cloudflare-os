import { useEffect, useRef } from 'react'
import { RpcStub, RpcTarget, newMessagePortRpcSession } from 'capnweb'
import { GatekeeperUiFrame } from '@gadgets/workshop-shared/gatekeeper'
import { createRateLimitedCapability } from './rateLimitedCapability'

// The host capability exposed to the sandboxed app over the MessagePort RPC session. The app reads
// `ui` to get the gatekeeper's capability; that's the only channel between the app and Workshop. The
// `ui` proxy is rate-limited: the app is untrusted (gatekeeper-authored HTML in a sandbox), so a
// long-lived app's calls are throttled rather than rejected when it gets bursty.
class GatekeeperAppHostImpl extends RpcTarget {
  readonly #ui: RpcStub<RpcTarget>
  readonly #disposeRateLimiter: () => void

  constructor(capability: any) {
    super()
    const { capability: ui, dispose } = createRateLimitedCapability(capability, {
      maxConcurrency: 8,
      maxCallsPerMinute: 600,
      maxPendingCalls: 128,
      onRateLimit: 'throttle',
      label: 'Gatekeeper app',
    })
    this.#ui = ui
    this.#disposeRateLimiter = dispose
  }

  get ui(): RpcStub<RpcTarget> {
    return this.#ui
  }

  // Cancel the rate limiter's pending resume timer once this host is no longer in use.
  dispose() {
    this.#disposeRateLimiter()
  }
}

// Hosts a gatekeeper's full-page management SPA in a sandboxed, network-isolated iframe. The app
// talks to the gatekeeper only through the `ui` capability carried over the MessagePort RPC session.
// The iframe fills its parent container.
export default function SandboxedGatekeeperApp({ frame }: {
  frame: GatekeeperUiFrame,
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const sessionRef = useRef<{ [Symbol.dispose]?(): void } | null>(null)
  const hostRef = useRef<GatekeeperAppHostImpl | null>(null)
  const connectedRef = useRef(false)
  const invalidatedRef = useRef(false)
  // The gatekeeper capability is `any`: its method shape is gatekeeper-defined and opaque to us.
  const capabilityRef = useRef<any>(null)
  capabilityRef.current = frame.ui

  useEffect(() => {
    connectedRef.current = false
    invalidatedRef.current = false

    const connect = (port: MessagePort) => {
      if (connectedRef.current) {
        // A second handshake (e.g. iframe reloaded) invalidates the session.
        invalidatedRef.current = true
        port.close()
        sessionRef.current?.[Symbol.dispose]?.()
        sessionRef.current = null
        hostRef.current?.dispose()
        hostRef.current = null
        return
      }
      if (invalidatedRef.current || !capabilityRef.current) {
        port.close()
        return
      }
      const host = new GatekeeperAppHostImpl(capabilityRef.current)
      hostRef.current = host
      sessionRef.current = newMessagePortRpcSession(port, host)
      connectedRef.current = true
    }

    const handleMessage = (event: MessageEvent) => {
      // Only accept the handshake from our own sandboxed iframe (which posts from a null origin).
      // Capture contentWindow first: if the frame isn't mounted there's no legitimate sender, so
      // reject — comparing against a concrete window avoids a `source === undefined` edge.
      const frameWindow = iframeRef.current?.contentWindow
      if (!frameWindow || event.source !== frameWindow || event.origin !== 'null') return
      if (invalidatedRef.current) return
      if (event.data?.type === 'handshake' && event.ports?.[0]) {
        connect(event.ports[0])
      }
    }

    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
      sessionRef.current?.[Symbol.dispose]?.()
      sessionRef.current = null
      hostRef.current?.dispose()
      hostRef.current = null
    }
    // Re-establish the session if either the HTML or the `ui` capability changes, so a new frame
    // carrying a fresh stub (even with identical HTML) never keeps talking through the stale one.
  }, [frame.iframeHtml, frame.ui])

  return (
    <iframe
      ref={iframeRef}
      srcDoc={frame.iframeHtml}
      // allow-scripts: run the app's JS. allow-modals: let it use confirm()/alert() (e.g. delete
      // confirmations) and the beforeunload unsaved-changes guard. Deliberately NOT allow-same-origin
      // (the frame stays an opaque origin) and the app's CSP keeps connect-src 'none', so network
      // isolation is unaffected.
      sandbox="allow-scripts allow-modals"
      title="Gatekeeper app"
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        border: 0,
        background: 'transparent',
      }}
    />
  )
}
