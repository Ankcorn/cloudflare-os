import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { RpcStub } from 'capnweb'
import { Overseer } from '@gadgets/workshop-shared/api'
import { ActionKind } from '@gadgets/workshop-shared/gatekeeper'

// Enables an auto-approval rule for the action's (bindingName, actionKind.tag), and tracks
// which tags were just enabled so callers can hide the affordance immediately on every same-tag
// pending row, rather than waiting for the action-log subscription to catch up.
export function useAlwaysApproveTag(
    overseer: RpcStub<Overseer>,
    setProcessingActions: Dispatch<SetStateAction<Set<number>>>,
    // Invoked after a rule is successfully enabled, so other views (e.g. the Connections rule list)
    // can refresh without waiting to be re-opened.
    onEnabled?: () => void) {
  const toasts = useKumoToastManager()
  const [enabledTags, setEnabledTags] = useState<Set<string>>(new Set())

  // Enable auto-approval for the action's class. Returns true on success, false on failure (the
  // error is surfaced via a toast) so the caller can decide whether to dismiss a confirm dialog.
  const alwaysApproveTag = useCallback(
      async (actionId: number, bindingName: string,
             actionKind: ActionKind): Promise<boolean> => {
    setProcessingActions(prev => new Set(prev).add(actionId))
    try {
      await overseer.setAutoApprovedActionKind(bindingName, actionKind)
      setEnabledTags(prev => new Set(prev).add(`${bindingName}:${actionKind.tag}`))
      onEnabled?.()
      return true
    } catch (err) {
      console.error('Failed to enable auto-approval:', err)
      toasts.add({ title: 'Failed to enable auto-approval', variant: 'error' })
      return false
    } finally {
      setProcessingActions(prev => {
        const next = new Set(prev)
        next.delete(actionId)
        return next
      })
    }
  }, [overseer, setProcessingActions, toasts, onEnabled])

  const isTagAutoApproved = useCallback(
      (bindingName: string, tag: string) => enabledTags.has(`${bindingName}:${tag}`),
      [enabledTags])

  return { alwaysApproveTag, isTagAutoApproved }
}
