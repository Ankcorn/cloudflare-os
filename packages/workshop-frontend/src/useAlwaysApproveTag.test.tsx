// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type Dispatch, type SetStateAction } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import { useAlwaysApproveTag } from './useAlwaysApproveTag'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: vi.fn<() => void>() }),
}))

const ACTION_KIND: ActionKind = { tag: 'send', label: 'Send' }

describe('useAlwaysApproveTag', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
  })

  it('forgets locally enabled tags only when a newer invalidation arrives', async () => {
    const overseer = {
      setAutoApprovedActionKind:
        vi.fn<(_gatekeeperId: number, _actionKind: ActionKind) => Promise<void>>(async () => {}),
    } as unknown as RpcStub<Overseer>
    const setProcessingActions =
      vi.fn<(_value: SetStateAction<Set<number>>) => void>() as unknown as
        Dispatch<SetStateAction<Set<number>>>
    let state: ReturnType<typeof useAlwaysApproveTag> | undefined

    function Probe({ invalidations }: { invalidations: ReadonlyMap<number, number> }) {
      state = useAlwaysApproveTag(
        overseer,
        setProcessingActions,
        undefined,
        invalidations,
      )
      return null
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe invalidations={new Map()} />))
    await act(async () => { await state!.alwaysApproveTag(1, 7, ACTION_KIND) })
    expect(state!.isTagAutoApproved(7, ACTION_KIND.tag)).toBe(true)

    await act(async () => root!.render(<Probe invalidations={new Map([[7, 10]])} />))
    expect(state!.isTagAutoApproved(7, ACTION_KIND.tag)).toBe(false)

    await act(async () => { await state!.alwaysApproveTag(2, 7, ACTION_KIND) })
    await act(async () => root!.render(<Probe invalidations={new Map([[7, 10]])} />))
    expect(state!.isTagAutoApproved(7, ACTION_KIND.tag)).toBe(true)

    await act(async () => root!.render(<Probe invalidations={new Map([[7, 11]])} />))
    expect(state!.isTagAutoApproved(7, ACTION_KIND.tag)).toBe(false)
  })
})
