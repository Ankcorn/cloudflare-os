import { useState, useEffect, useRef } from 'react'
import { Typography, Spin, Alert } from 'antd'
import { RpcStub, newMessagePortRpcSession } from 'capnweb'
import { Overseer, UiBundle } from '@minions/workshop-shared/api'

const { Text } = Typography

// We want to inject Cap'n Web into the Minion. Luckily it has no dependencies, so we can just take
// the whole module and embed it. We can import the module using ?raw to get a string of the
// content.
import CAPNWEB_BUNDLE from 'capnweb?raw'

let CAPNWEB_BUNDLE_ANNOTATED = `//# sourceURL=jsrpc.js\n${CAPNWEB_BUNDLE}`

// Unfortunately, we will have to embed the code as a data: URL, because our iframe is totally
// sandboxed. Even more unfortuntaely, since it's a module which we need to import from, we can't
// use the data URL as a <script> tag's source. Instead, we have to use it in an import statement.
// And, guess what? That import statement is going to appear in code which is *also* embedded in
// a data: URL, so we have a doubly-nested data: URL. We'll use base64 encoding for the inner
// data: and URL encoding for the outer, as this lagely avoids double-escaping.
//
// In any case, we'll prefix the minion code with this prefix which imports the Cap'n Web library
// (from a massive data URL) and sets up the RPC connection to the parent.
let INJECTED_CODE_PREFIX = encodeURIComponent(`//# sourceURL=client.js
import { RpcStub, newMessagePortRpcSession } from "data:text/javascript;charset=utf-8;base64,${btoa(CAPNWEB_BUNDLE_ANNOTATED)}";

let minion;  // RPC stub to the minion's server-side Durable Object.
{
  let {port1, port2} = new MessageChannel();
  window.parent.postMessage("handshake", "*", [port2]);
  minion = newMessagePortRpcSession(port1);
}

`);

const createSandboxedHtml = (jsCode: string): string => {
  return `<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'none'; script-src data: 'unsafe-inline'; style-src data: 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';">
</head>
<body>
    <script type="module" src="data:text/javascript;charset=utf-8,${INJECTED_CODE_PREFIX}${encodeURIComponent(jsCode)}"></script>
</body>
</html>`.trim()
}

interface MinionUIProps {
  overseer: RpcStub<Overseer>
  height: string
  reloadTrigger?: number
  isVisible?: boolean
}

export default function MinionUI({ overseer, height, reloadTrigger, isVisible = true }: MinionUIProps) {
  const [sandboxedHtml, setSandboxedHtml] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [isInvalidated, setIsInvalidated] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const prevReloadTriggerRef = useRef(reloadTrigger)
  const minionStubRef = useRef<RpcStub<any> | null>(null)
  const rpcSessionRef = useRef<RpcStub<any> | null>(null)

  // Effect to handle reloadTrigger changes (code changes)
  useEffect(() => {
    // Only react if reloadTrigger has actually changed from the previous value
    if (reloadTrigger !== prevReloadTriggerRef.current && reloadTrigger > 0) {
      // Mark as invalidated but don't reload unless visible
      setIsInvalidated(true)
      if (!isVisible) {
        // If not visible, just clear the current state
        setSandboxedHtml(null)
        setHasLoaded(false)
        setError(null)
      }
      // Update the ref to the current value
      prevReloadTriggerRef.current = reloadTrigger
    }
  }, [reloadTrigger, isVisible])

  // Effect to load UI bundle when component becomes visible for the first time or when invalidated
  useEffect(() => {
    // Only load if:
    // 1. Component is visible AND
    // 2. Either never loaded before OR invalidated due to code changes
    if (!isVisible || (hasLoaded && !isInvalidated)) {
      return
    }

    const loadUiBundle = async () => {
      try {
        setLoading(true)
        setError(null)

        const bundle = await overseer.getUiBundle()
        if (bundle) {
          const html = createSandboxedHtml(bundle.jsCode)
          setSandboxedHtml(html)
        } else {
          setSandboxedHtml(null)
        }
        setHasLoaded(true)
        setIsInvalidated(false)
      } catch (err) {
        console.error('Failed to load UI bundle:', err)
        setError('Failed to load UI bundle')
      } finally {
        setLoading(false)
      }
    }

    loadUiBundle()
  }, [overseer, isVisible, hasLoaded, isInvalidated])

  // Effect to handle iframe RPC handshake
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      // Only handle messages from our iframe
      if (event.source !== iframeRef.current?.contentWindow) {
        return
      }

      if (event.data === 'handshake' && event.ports && event.ports[0]) {
        try {
          // Get the minion stub from overseer
          const minionStub = await overseer.connectToMinion()
          minionStubRef.current = minionStub

          // Create RPC session using the MessagePort and expose the minion stub
          const port = event.ports[0]
          const rpcSession = newMessagePortRpcSession(port, minionStub)
          rpcSessionRef.current = rpcSession
        } catch (error) {
          console.error('Failed to establish RPC connection:', error)
        }
      }
    }

    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
    }
  }, [overseer])

  // Effect to handle cleanup when component unmounts or reloads
  useEffect(() => {
    return () => {
      // Dispose of RPC resources
      if (minionStubRef.current) {
        minionStubRef.current[Symbol.dispose]?.()
        minionStubRef.current = null
      }
      if (rpcSessionRef.current) {
        rpcSessionRef.current[Symbol.dispose]?.()
        rpcSessionRef.current = null
      }
    }
  }, [reloadTrigger])

  if (!isVisible && !hasLoaded) {
    // Don't render anything if not visible and never loaded
    return (
      <div style={{
        height,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        color: '#999'
      }}>
        <Text type="secondary">
          Switch to this tab to load the Minion UI
        </Text>
      </div>
    )
  }

  if (loading) {
    return (
      <div style={{
        height,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center'
      }}>
        <Spin size="large" />
      </div>
    )
  }

  if (error) {
    return (
      <div style={{
        height,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '20px'
      }}>
        <Alert
          message="Error"
          description={error}
          type="error"
          showIcon
        />
      </div>
    )
  }

  if (!sandboxedHtml) {
    return (
      <div style={{
        height,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        color: '#999'
      }}>
        <Text type="secondary">
          This Minion doesn't have a custom UI yet. The UI will appear here when the Minion implements one.
        </Text>
      </div>
    )
  }

  return (
    <div style={{ height, width: '100%' }}>
      <iframe
        ref={iframeRef}
        srcDoc={sandboxedHtml}
        style={{
          width: '100%',
          height: '100%',
          border: 'none'
        }}
        sandbox="allow-scripts"
        title="Minion UI"
      />
    </div>
  )
}