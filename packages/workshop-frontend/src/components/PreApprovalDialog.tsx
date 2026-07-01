import { useEffect, useMemo, useState } from 'react'
import { Checkbox, Dialog } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import { PreApprovableAction } from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton } from './WorkshopControls'

interface PreApprovalDialogProps {
  open: boolean
  // Uncovered actions (no auto-approval rule yet) the user can pre-approve.
  candidates: PreApprovableAction[]
  isProcessing?: boolean
  onOpenChange: (open: boolean) => void
  // Apply auto-approval for the selected actions.
  onConfirm: (selected: PreApprovableAction[]) => void
  // "Not now" -- persist a dismissal so we don't nag on reload.
  onDismiss: () => void
}

function actionKey(a: PreApprovableAction): string {
  return `${a.bindingName}:${a.actionKind.tag}`
}

// Proactively offered when a gadget is set to run unattended (an enabled hook) and a connected
// gatekeeper has auto-approvable actions. Pre-approving up front means the first scheduled/hook run
// doesn't get stuck with an action sitting pending in the Activity log forever.
export default function PreApprovalDialog({
  open,
  candidates,
  isProcessing = false,
  onOpenChange,
  onConfirm,
  onDismiss,
}: PreApprovalDialogProps) {
  // Per-row selection, keyed by `${bindingName}:${actionKind.tag}`. Default: everything on.
  const [deselected, setDeselected] = useState<Set<string>>(new Set())

  // Reset to "everything on" each time the dialog opens, so deselections from a previous open (or a
  // since-changed candidate list) don't carry over.
  useEffect(() => {
    if (open) setDeselected(new Set())
  }, [open])

  // Group candidates by connection for display.
  const groups = useMemo(() => {
    const byBinding = new Map<string, PreApprovableAction[]>()
    for (const a of candidates) {
      const list = byBinding.get(a.bindingName)
      if (list) list.push(a)
      else byBinding.set(a.bindingName, [a])
    }
    return [...byBinding.entries()]
  }, [candidates])

  const selected = candidates.filter(a => !deselected.has(actionKey(a)))

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isProcessing) onOpenChange(nextOpen)
      }}
    >
      <Dialog
        className="!z-[1000] !w-[min(480px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0 !top-[20%] !-translate-y-0"
        size="sm"
      >
        <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div className="min-w-0">
            <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
              Pre-approve actions for unattended runs?
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              This gadget runs unattended. Pre-approve these actions so it doesn't get stuck
              waiting for approval.
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton
                {...props}
                className="!h-7 !w-7"
                disabled={isProcessing}
                aria-label="Close"
              >
                <X size={16} />
              </WorkshopIconButton>
            )}
          />
        </div>

        <div className="max-h-[50vh] overflow-auto px-5 py-3">
          {groups.map(([bindingName, actions]) => (
            <div key={bindingName} className="mb-3 last:mb-0">
              <div className="mb-1.5 font-mono text-[11px] text-kumo-subtle">{bindingName}</div>
              <div className="flex flex-col gap-1">
                {actions.map((a) => {
                  const k = actionKey(a)
                  return (
                    <div
                      key={k}
                      className={`rounded-xl px-3 py-2 transition-colors ${
                        deselected.has(k)
                          ? 'bg-kumo-elevated/50 hover:bg-kumo-elevated'
                          : 'bg-kumo-tint'
                      }`}
                    >
                      <Checkbox
                        label={
                          <span className="truncate text-[12px] font-medium text-kumo-default">
                            {a.actionKind.label}
                          </span>
                        }
                        checked={!deselected.has(k)}
                        onCheckedChange={(checked) => {
                          setDeselected((prev) => {
                            const next = new Set(prev)
                            if (checked) next.delete(k)
                            else next.add(k)
                            return next
                          })
                        }}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
          <WorkshopButton className="!h-9" disabled={isProcessing} onClick={onDismiss}>
            Not now
          </WorkshopButton>
          <WorkshopButton
            tone="primary"
            onClick={() => onConfirm(selected)}
            disabled={isProcessing || selected.length === 0}
            className="!h-9 min-w-[64px]"
          >
            {isProcessing ? 'Pre-approving...' : 'Pre-approve'}
          </WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
