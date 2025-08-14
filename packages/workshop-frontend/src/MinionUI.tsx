import { useState, useEffect, useRef } from 'react'
import { Typography, Spin, Alert } from 'antd'
import { RpcStub } from '@cloudflare/jsrpc'
import { Overseer, UiBundle } from '@minions/workshop-shared/api'

const { Text } = Typography

const createSandboxedHtml = (jsCode: string): string => {
  return `
<!DOCTYPE html>
<html>
<head></head>
<body>
    <script src="data:text/javascript;charset=utf-8,${encodeURIComponent(jsCode)}"></script>
</body>
</html>
  `.trim()
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