import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { RpcStub, RpcTarget, newMessagePortRpcSession } from 'capnweb'
import { ResourceConfiguratorFrame, ResourceConfiguratorHost, ResourceConfiguratorIframe } from '@gadgets/workshop-shared/gatekeeper'

// Upper bound on iframe height. Sized to leave room for a typical configurator form plus an open
// autocomplete popup, while staying within a reasonable viewport even on short screens.
const MAX_CONFIGURATOR_HEIGHT = 720
const MIN_CONFIGURATOR_HEIGHT = 80
const MAX_CONFIGURATOR_RPC_CONCURRENCY = 4
const MAX_CONFIGURATOR_RPC_CALLS_PER_MINUTE = 120
const MAX_CONFIGURATOR_RPC_PENDING_CALLS = 32
// Cap on each scroll delta forwarded from the iframe, so a misbehaving iframe can't post
// extreme values to scroll-jack the host modal.
const SCROLL_FORWARD_MAX_DELTA = 1000
const COLLECT_VALUES_TIMEOUT_MS = 5000

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function createRateLimitedConfigurator(configurator: any): any {
  type QueuedCall = {
    method: string
    args: unknown[]
    resolve: (value: unknown) => void
    reject: (reason?: unknown) => void
  }

  const startedCalls: number[] = []
  const queue: QueuedCall[] = []
  let inFlight = 0

  const pruneCallWindow = () => {
    const cutoff = Date.now() - 60_000
    while (startedCalls.length > 0 && startedCalls[0] < cutoff) startedCalls.shift()
  }

  const drain = () => {
    pruneCallWindow()
    while (inFlight < MAX_CONFIGURATOR_RPC_CONCURRENCY && queue.length > 0) {
      if (startedCalls.length >= MAX_CONFIGURATOR_RPC_CALLS_PER_MINUTE) {
        queue.shift()?.reject(new Error('Resource configurator made too many requests.'))
        continue
      }

      const call = queue.shift()!
      if (typeof configurator?.[call.method] !== 'function') {
        call.reject(new Error(`Resource configurator method is not available: ${call.method}`))
        continue
      }

      startedCalls.push(Date.now())
      inFlight++
      Promise.resolve()
        .then(() => configurator[call.method](...call.args))
        .then(call.resolve, call.reject)
        .finally(() => {
          inFlight--
          drain()
        })
    }
  }

  return new Proxy(new (class extends RpcTarget {})(), {
    get(_target, property) {
      if (property === 'then') return undefined
      if (property === Symbol.dispose) return undefined
      if (typeof property !== 'string') return undefined
      return (...args: unknown[]) => new Promise((resolve, reject) => {
        if (queue.length + inFlight >= MAX_CONFIGURATOR_RPC_PENDING_CALLS) {
          reject(new Error('Resource configurator has too many pending requests.'))
          return
        }
        queue.push({ method: property, args, resolve, reject })
        drain()
      })
    },
  })
}

class ResourceConfiguratorHostImpl extends RpcTarget implements ResourceConfiguratorHost {
  readonly #gatekeeper: RpcStub<RpcTarget>

  constructor(
    configurator: any,
    private readonly onResize: (height: number, layoutHeight: number) => void,
    private readonly onSelectionReady: (ready: boolean) => void,
    private readonly onScroll: (deltaX: number, deltaY: number) => void,
  ) {
    super()
    this.#gatekeeper = createRateLimitedConfigurator(configurator)
  }

  get gatekeeper(): RpcStub<RpcTarget> {
    return this.#gatekeeper
  }

  resize(height: number, layoutHeight: number): void {
    this.onResize(height, layoutHeight)
  }

  setSelectionReady(ready: boolean): void {
    this.onSelectionReady(ready)
  }

  forwardScroll(deltaX: number, deltaY: number): void {
    this.onScroll(deltaX, deltaY)
  }
}

export default function SandboxedResourceConfigurator({
  frame,
  onCollectResourceUrlChange,
  onSelectionReadyChange,
}: {
  frame: ResourceConfiguratorFrame,
  onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void,
  onSelectionReadyChange?: (ready: boolean | null) => void,
}) {
  const placeholderRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const rpcSessionRef = useRef<{ [Symbol.dispose]?(): void } | null>(null)
  const iframeRpcRef = useRef<RpcStub<ResourceConfiguratorIframe> | null>(null)
  // The configurator stub is an arbitrary gatekeeper-defined capability: its method shape is
  // unknown to Workshop, so we treat it as `any` and let Cap'n Web carry calls through.
  const configuratorRef = useRef<any>(null)
  const iframeConnectedRef = useRef(false)
  const iframeInvalidatedRef = useRef(false)
  const iframeLoadCountRef = useRef(0)
  const pendingScrollRef = useRef({ x: 0, y: 0 })
  const scrollFrameRef = useRef<number | null>(null)
  const [height, setHeight] = useState(MIN_CONFIGURATOR_HEIGHT)
  const [layoutHeight, setLayoutHeight] = useState(MIN_CONFIGURATOR_HEIGHT)
  const [frameRect, setFrameRect] = useState<{ top: number, left: number, width: number } | null>(null)
  const [clipInsets, setClipInsets] = useState<{ top: number, right: number, bottom: number, left: number } | null>(null)
  const heightRef = useRef(MIN_CONFIGURATOR_HEIGHT)
  heightRef.current = height
  const layoutHeightRef = useRef(MIN_CONFIGURATOR_HEIGHT)
  layoutHeightRef.current = layoutHeight
  configuratorRef.current = frame.ui

  // Cached scroll ancestor of the placeholder. We rediscover it lazily because the modal DOM is
  // stable for the lifetime of the configurator, so walking up via getComputedStyle on every event is
  // wasted work.
  const scrollAncestorRef = useRef<HTMLElement | null>(null)
  const findScrollAncestor = (): HTMLElement | null => {
    if (scrollAncestorRef.current && scrollAncestorRef.current.isConnected) return scrollAncestorRef.current
    let node = placeholderRef.current?.parentElement ?? null
    while (node && node !== document.documentElement) {
      const cs = getComputedStyle(node)
      if (cs.overflowY === 'auto' || cs.overflowY === 'scroll' || cs.overflowY === 'hidden') {
        scrollAncestorRef.current = node
        return node
      }
      node = node.parentElement
    }
    scrollAncestorRef.current = null
    return null
  }

  // rAF-batched recompute. Scroll events fire at native rate; we coalesce to one update per frame
  // and skip setState when nothing changed to avoid forcing a re-render on every wheel tick.
  const updateScheduledRef = useRef(false)
  const lastFrameRectRef = useRef<{ top: number, left: number, width: number } | null>(null)
  const lastClipRef = useRef<{ top: number, right: number, bottom: number, left: number } | null>(null)
  const updateFrameRect = () => {
    if (updateScheduledRef.current) return
    updateScheduledRef.current = true
    requestAnimationFrame(() => {
      updateScheduledRef.current = false
      const placeholder = placeholderRef.current
      const rect = placeholder?.getBoundingClientRect()
      if (!placeholder || !rect) return

      const nextRect = { top: rect.top, left: rect.left, width: rect.width }
      const prevRect = lastFrameRectRef.current
      const rectChanged = !prevRect
        || prevRect.top !== nextRect.top
        || prevRect.left !== nextRect.left
        || prevRect.width !== nextRect.width
      if (rectChanged) {
        lastFrameRectRef.current = nextRect
        setFrameRect(nextRect)
      }

      // Notify the iframe of viewport position so floating popups can clamp their max-height.
      if (rectChanged && iframeConnectedRef.current) {
        iframeRpcRef.current?.updateViewport(rect.top, window.innerHeight)
      }

      // Clip the iframe to the nearest scrollable ancestor (typically the modal's scroll area).
      // In normal viewports the modal grows tall enough that no clipping is needed, but when the
      // viewport is too short for the modal to fully expand, the inner scroll-area takes over and
      // this clip prevents the iframe from rendering over the modal's footer.
      const ancestor = findScrollAncestor()
      let nextClip: { top: number, right: number, bottom: number, left: number } | null = null
      if (ancestor) {
        const ancestorRect = ancestor.getBoundingClientRect()
        // When popup is open (iframe taller than layout), allow bottom overflow so dropdowns can
        // extend past the modal like native autocomplete behavior.
        const popupOpen = heightRef.current > layoutHeightRef.current + 8
        nextClip = {
          top: Math.max(0, ancestorRect.top - rect.top),
          right: Math.max(0, (rect.left + rect.width) - ancestorRect.right),
          bottom: popupOpen ? 0 : Math.max(0, (rect.top + heightRef.current) - ancestorRect.bottom),
          left: Math.max(0, ancestorRect.left - rect.left),
        }
      }
      const prevClip = lastClipRef.current
      const clipChanged = !prevClip !== !nextClip
        || (prevClip && nextClip && (
          prevClip.top !== nextClip.top
          || prevClip.right !== nextClip.right
          || prevClip.bottom !== nextClip.bottom
          || prevClip.left !== nextClip.left
        ))
      if (clipChanged) {
        lastClipRef.current = nextClip
        setClipInsets(nextClip)
      }
    })
  }

  const connectIframe = (port: MessagePort) => {
    if (iframeConnectedRef.current) {
      iframeInvalidatedRef.current = true
      port.close()
      iframeRpcRef.current?.[Symbol.dispose]?.()
      iframeRpcRef.current = null
      rpcSessionRef.current?.[Symbol.dispose]?.()
      rpcSessionRef.current = null
      return
    }
    if (iframeInvalidatedRef.current) return
    if (!configuratorRef.current) {
      port.close()
      return
    }
    rpcSessionRef.current?.[Symbol.dispose]?.()
    const iframe = newMessagePortRpcSession<ResourceConfiguratorIframe>(port, new ResourceConfiguratorHostImpl(
      configuratorRef.current,
      (nextHeight, nextLayoutHeight) => {
        if (!Number.isFinite(nextHeight)) return
        const maxHeight = Math.max(MIN_CONFIGURATOR_HEIGHT, Math.min(MAX_CONFIGURATOR_HEIGHT, window.innerHeight - 120))
        setHeight(clamp(Math.ceil(nextHeight), MIN_CONFIGURATOR_HEIGHT, maxHeight))
        const layoutHeight = Number.isFinite(nextLayoutHeight) ? nextLayoutHeight : nextHeight
        setLayoutHeight(clamp(Math.ceil(layoutHeight), MIN_CONFIGURATOR_HEIGHT, maxHeight))
      },
      ready => onSelectionReadyChange?.(Boolean(ready)),
      (deltaX, deltaY) => applyForwardedScroll(
        clamp(Number(deltaX) || 0, -SCROLL_FORWARD_MAX_DELTA, SCROLL_FORWARD_MAX_DELTA),
        clamp(Number(deltaY) || 0, -SCROLL_FORWARD_MAX_DELTA, SCROLL_FORWARD_MAX_DELTA),
      ),
    ))
    rpcSessionRef.current = iframe
    iframeRpcRef.current?.[Symbol.dispose]?.()
    iframeRpcRef.current = iframe.dup()
    const placeholderRect = placeholderRef.current?.getBoundingClientRect()
    if (placeholderRect) {
      iframe.updateViewport(placeholderRect.top, window.innerHeight)
    }
    iframeConnectedRef.current = true
  }

  const handleIframeLoad = () => {
    iframeLoadCountRef.current++
    if (iframeLoadCountRef.current > 1) {
      iframeInvalidatedRef.current = true
      iframeRpcRef.current?.[Symbol.dispose]?.()
      iframeRpcRef.current = null
      rpcSessionRef.current?.[Symbol.dispose]?.()
      rpcSessionRef.current = null
    }
  }

  const collectResourceUrl = () => {
    if (iframeInvalidatedRef.current) return Promise.reject(new Error('Configurator is no longer available.'))
    const iframe = iframeRpcRef.current
    if (!iframe || !iframeConnectedRef.current) return Promise.reject(new Error('Configurator is not ready.'))

    let timeout: number | null = null
    return Promise.race([
      iframe.collectResourceUrl(),
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => {
          reject(new Error('Configurator did not provide its resource URL. Please try again.'))
        }, COLLECT_VALUES_TIMEOUT_MS)
      }),
    ]).finally(() => {
      if (timeout !== null) window.clearTimeout(timeout)
    })
  }

  const applyForwardedScroll = (deltaX: number, deltaY: number) => {
    pendingScrollRef.current.x += deltaX
    pendingScrollRef.current.y += deltaY
    if (scrollFrameRef.current !== null) return
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null
      const deltaX = clamp(pendingScrollRef.current.x, -SCROLL_FORWARD_MAX_DELTA, SCROLL_FORWARD_MAX_DELTA)
      const deltaY = clamp(pendingScrollRef.current.y, -SCROLL_FORWARD_MAX_DELTA, SCROLL_FORWARD_MAX_DELTA)
      pendingScrollRef.current = { x: 0, y: 0 }
      if (deltaY === 0 && deltaX === 0) return
      const target = findScrollAncestor()
      if (target && target.scrollHeight > target.clientHeight) {
        target.scrollBy({ top: deltaY, left: deltaX })
      }
    })
  }

  useLayoutEffect(() => {
    iframeConnectedRef.current = false
    iframeInvalidatedRef.current = false
    iframeLoadCountRef.current = 0
    onSelectionReadyChange?.(null)
    iframeRpcRef.current?.[Symbol.dispose]?.()
    iframeRpcRef.current = null
    rpcSessionRef.current?.[Symbol.dispose]?.()
    rpcSessionRef.current = null
    scrollAncestorRef.current = null
    lastFrameRectRef.current = null
    lastClipRef.current = null
    setHeight(MIN_CONFIGURATOR_HEIGHT)
    setLayoutHeight(MIN_CONFIGURATOR_HEIGHT)
    updateFrameRect()
  }, [frame.iframeHtml])

  useEffect(() => {
    onCollectResourceUrlChange?.(collectResourceUrl)
    return () => {
      onCollectResourceUrlChange?.(null)
    }
  }, [onCollectResourceUrlChange])

  useLayoutEffect(() => {
    updateFrameRect()
  }, [layoutHeight, height])

  useEffect(() => {
    updateFrameRect()
    const update = () => updateFrameRect()
    const onResize = () => {
      updateFrameRect()
      if (iframeConnectedRef.current) {
        iframeRpcRef.current?.windowResized()
      }
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', update, true)
    }
  }, [])

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== 'null') return
      if (iframeInvalidatedRef.current) return

      if (event.data?.type === 'handshake' && event.ports?.[0]) {
        connectIframe(event.ports[0])
      }
    }

    window.addEventListener('message', handleMessage)
    return () => {
      window.removeEventListener('message', handleMessage)
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current)
      onSelectionReadyChange?.(null)
      iframeRpcRef.current?.[Symbol.dispose]?.()
      iframeRpcRef.current = null
      rpcSessionRef.current?.[Symbol.dispose]?.()
      rpcSessionRef.current = null
    }
  }, [])

  return (
    <>
      <div ref={placeholderRef} style={{ height: layoutHeight }} />
      {frameRect && createPortal(<iframe
        ref={iframeRef}
        srcDoc={frame.iframeHtml}
        onLoad={handleIframeLoad}
        sandbox="allow-scripts"
        title="Resource configurator"
        scrolling="no"
        style={{
          position: 'fixed',
          top: frameRect.top,
          left: frameRect.left,
          zIndex: 2147483647,
          display: 'block',
          width: frameRect.width,
          height,
          clipPath: clipInsets
            ? `inset(${clipInsets.top}px ${clipInsets.right}px ${clipInsets.bottom}px ${clipInsets.left}px)`
            : undefined,
          border: 0,
          background: 'transparent',
          pointerEvents: 'auto',
        }}
      />, document.body)}
    </>
  )
}
