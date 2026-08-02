// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'
import { useServerConfig } from '../ServerConfigContext'
import { forceReconnect, probeGatekeeperVendorIds } from '../main'

vi.mock('../main', () => ({
  forceReconnect: vi.fn<typeof forceReconnect>(),
  probeGatekeeperVendorIds: vi.fn<typeof probeGatekeeperVendorIds>(),
}))
vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: vi.fn<typeof useAuthenticatedApi>(),
  useOptionalAuthenticatedApi: () => null,
}))
vi.mock('../ServerConfigContext', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useServerConfig: vi.fn<typeof useServerConfig>(),
}))
// The real kumo hook returns a fresh object every render — mirror that, so anything keyed on the
// manager's identity misbehaves here the same way it would in production.
vi.mock('@cloudflare/kumo', () => ({ useKumoToastManager: () => ({ ...toastManager }) }))
vi.mock('../components/ConnectConnectorModal', () => ({ default: () => null }))
vi.mock('../components/ViewToggle', () => ({ default: () => null }))
vi.mock('../components/EmptyState', () => ({
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))
const toastManager = { add: vi.fn<(toast: { title: string; variant: string }) => void>() }

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { ConnectorsPage } from './gatekeepers'

function vendorInfo(id: string, unavailable = false): GatekeeperVendorInfo {
  return {
    id,
    ...(unavailable ? { unavailable: true } : {}),
    description: { displayName: id, url: `https://${id}.test`, tagline: '', description: '' },
    supportedResources: [],
  }
}

// Minimal AuthenticatedApi: vendor listing per test, no addable gatekeepers, an
// immediately-ready empty accounts subscription.
function makeApi(listGatekeeperVendors: () => Promise<GatekeeperVendorInfo[]>) {
  return {
    listGatekeeperVendors: vi.fn<() => Promise<GatekeeperVendorInfo[]>>(listGatekeeperVendors),
    listAddableGatekeepers: vi.fn<() => Promise<GatekeeperVendorInfo[]>>(async () => []),
    subscribeConnectedAccounts: vi.fn<
      (subscriber: { ready: () => void }) => Promise<{ [Symbol.dispose](): void }>
    >(async (subscriber) => {
      subscriber.ready()
      return { [Symbol.dispose]() {} }
    }),
  } as unknown as RpcStub<AuthenticatedApi> & {
    listGatekeeperVendors: ReturnType<typeof vi.fn<() => Promise<GatekeeperVendorInfo[]>>>
  }
}

describe('ConnectorsPage vendor freshness', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  const probe = vi.mocked(probeGatekeeperVendorIds)
  const reconnect = vi.mocked(forceReconnect)

  async function render(api: ReturnType<typeof makeApi>, deployUrl: string | undefined) {
    vi.mocked(useAuthenticatedApi).mockReturnValue(
      { authenticatedApi: api } as unknown as ReturnType<typeof useAuthenticatedApi>,
    )
    vi.mocked(useServerConfig).mockReturnValue(
      (deployUrl ? { deployUrl } : {}) as ReturnType<typeof useServerConfig>,
    )
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<ConnectorsPage />))
  }

  async function focusWindow() {
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.useRealTimers()
  })

  it('loads and subscribes exactly once per connection, even across re-renders', async () => {
    const api = makeApi(async () => [vendorInfo('google')])
    await render(api, 'https://deploy.test')

    // Extra render passes (each giving the component a fresh toast-manager identity, like any
    // state update in production) must not re-trigger the load effect.
    await act(async () => root!.render(<ConnectorsPage />))
    await act(async () => root!.render(<ConnectorsPage />))

    expect(api.listGatekeeperVendors).toHaveBeenCalledTimes(1)
    expect(api.subscribeConnectedAccounts).toHaveBeenCalledTimes(1)
    expect(container!.textContent).not.toContain('Loading gatekeepers')
    expect(container!.textContent).toContain('google')
  })

  it('probes on focus and reconnects only when the vendor set changed', async () => {
    await render(makeApi(async () => [vendorInfo('google')]), 'https://deploy.test')

    // Same set as the last fetch: probe runs, no reconnect.
    probe.mockResolvedValue(new Set(['google']))
    await focusWindow()
    expect(probe).toHaveBeenCalledTimes(1)
    expect(reconnect).not.toHaveBeenCalled()

    // A new vendor appeared in the deployment: one reconnect.
    probe.mockResolvedValue(new Set(['google', 'slack']))
    await focusWindow()
    expect(reconnect).toHaveBeenCalledTimes(1)

    // Probe skipped (no token / error): no reconnect.
    probe.mockResolvedValue(null)
    await focusWindow()
    expect(reconnect).toHaveBeenCalledTimes(1)
  })

  it('does not listen for focus without a deployUrl', async () => {
    await render(makeApi(async () => [vendorInfo('google')]), undefined)

    probe.mockResolvedValue(new Set(['google', 'slack']))
    await focusWindow()
    expect(probe).not.toHaveBeenCalled()
  })

  it('polls only while the empty CTA state is showing, and stops at the cap', async () => {
    vi.useFakeTimers()
    probe.mockResolvedValue(null)
    await render(makeApi(async () => []), 'https://deploy.test')

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(probe).toHaveBeenCalledTimes(4)  // every 5s

    // After the 2-minute cap the interval is cleared.
    await act(async () => { await vi.advanceTimersByTimeAsync(110_000) })
    const atCap = probe.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(probe).toHaveBeenCalledTimes(atCap)
  })

  it('does not poll when vendors exist', async () => {
    vi.useFakeTimers()
    probe.mockResolvedValue(null)
    await render(makeApi(async () => [vendorInfo('google')]), 'https://deploy.test')

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(probe).not.toHaveBeenCalled()
  })

  it('retries unavailable vendors over the current connection, warning only once', async () => {
    vi.useFakeTimers()
    let calls = 0
    const api = makeApi(async () => {
      calls++
      // Cold gatekeeper worker: unavailable on the first two fetches, recovered on the third.
      return [vendorInfo('google', calls < 3)]
    })
    await render(api, undefined)

    expect(api.listGatekeeperVendors).toHaveBeenCalledTimes(1)
    expect(toastManager.add).toHaveBeenCalledTimes(1)
    expect(container!.textContent).not.toContain('google')

    // First retry (~5s): still unavailable — no second toast.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(api.listGatekeeperVendors).toHaveBeenCalledTimes(2)
    expect(toastManager.add).toHaveBeenCalledTimes(1)

    // Second retry (~15s): recovered — appears without any reconnect.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    expect(api.listGatekeeperVendors).toHaveBeenCalledTimes(3)
    expect(container!.textContent).toContain('google')
    expect(reconnect).not.toHaveBeenCalled()

    // No further retries are scheduled.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(api.listGatekeeperVendors).toHaveBeenCalledTimes(3)
  })
})
