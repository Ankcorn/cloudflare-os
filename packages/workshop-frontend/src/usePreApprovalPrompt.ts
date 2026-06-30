import { useCallback, useEffect, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { RpcStub } from 'capnweb'
import { Overseer, PreApprovableAction } from '@gadgets/workshop-shared/api'

// Loads the catalog of pre-approvable actions (auto-approvable action kinds not yet covered by a
// rule) across a gadget's connected gatekeepers, and drives the pre-approval dialog. Surfaced on
// demand from the chat menu and proactively when a new gatekeeper with such actions is connected,
// so an unattended run doesn't stall on an action sitting pending forever. The per-action
// `autoApprovable` verdict remains the binding gate at apply time -- pre-approving a kind never
// weakens it.
// `onChange` is invoked after a successful (or partially successful) pre-approve write, so the parent
// can invalidate other views of auto-approval state (e.g. bump the shared reload trigger the
// Connections tab listens to). Without it, a pre-approval wouldn't show elsewhere until a reload.
export function usePreApprovalPrompt(
  overseer: RpcStub<Overseer> | null,
  onChange?: () => void,
) {
  const toasts = useKumoToastManager()
  const [candidates, setCandidates] = useState<PreApprovableAction[]>([])
  const [isProcessing, setIsProcessing] = useState(false)

  // Reload the uncovered candidates and return them, so callers can decide whether to open the
  // dialog (e.g. right after connecting a new gatekeeper).
  const refresh = useCallback(async (): Promise<PreApprovableAction[]> => {
    if (!overseer) return []
    try {
      const actions = await overseer.listPreApprovableActions()
      const uncovered = actions.filter(a => !a.alreadyEnabled)
      setCandidates(uncovered)
      return uncovered
    } catch (err) {
      // listPreApprovableActions is an editor-only RPC; for use-only collaborators (or any transient
      // failure) it rejects, in which case there's simply nothing to pre-approve.
      console.error('Failed to load pre-approval candidates:', err)
      return []
    }
  }, [overseer])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Enable an auto-approval rule for each selected action, then recompute. The per-action
  // `autoApprovable` verdict remains the binding gate at apply time -- pre-approving a kind never
  // weakens it.
  const preApprove = useCallback(async (selected: PreApprovableAction[]) => {
    if (!overseer || selected.length === 0) return
    setIsProcessing(true)
    try {
      // The writes are independent, so fire them together rather than serializing N round-trips. Use
      // allSettled so one rejection doesn't abort the rest, and report how many failed.
      const results = await Promise.allSettled(
        selected.map(a => overseer.setAutoApprovedActionKind(a.bindingName, a.actionKind)),
      )
      const failures = results.filter(r => r.status === 'rejected')
      if (failures.length > 0) {
        console.error('Failed to pre-approve some actions:', failures)
        toasts.add({
          title: `Failed to pre-approve ${failures.length} of ${selected.length} actions`,
          variant: 'error',
        })
      }
    } finally {
      // Always recompute -- even on partial failure -- so `candidates` reflects what actually got
      // enabled rather than going stale.
      await refresh()
      // Notify the parent so other views of auto-approval state (the Connections tab) refresh too.
      onChange?.()
      setIsProcessing(false)
    }
  }, [overseer, refresh, toasts, onChange])

  return { candidates, refresh, preApprove, isProcessing }
}
