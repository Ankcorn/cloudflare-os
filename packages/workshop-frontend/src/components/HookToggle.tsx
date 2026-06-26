import { Switch, Tooltip } from '@cloudflare/kumo'

interface HookToggleProps {
  enabled: boolean
  disabled?: boolean
  onToggle: (enabled: boolean) => void
  size?: 'sm' | 'base' | 'lg'
  // Noun for the tooltip/aria copy (e.g. "hook", "auto-approval rule"). Defaults to "hook".
  label?: string
}

// Enable/disable toggle. Originally for bound hooks; also reused for other on/off concepts (e.g.
// auto-approval rules) via `label`. Used in the Connections tab, the Activity log, and inline chat
// action cards.
export function HookToggle({ enabled, disabled = false, onToggle, size = 'sm', label = 'hook' }: HookToggleProps) {
  return (
    <Tooltip content={enabled ? `Disable this ${label}.` : `Enable this ${label}.`} asChild>
      <span className="inline-flex items-center">
        <Switch
          checked={enabled}
          disabled={disabled}
          size={size}
          onCheckedChange={(checked) => onToggle(checked)}
          aria-label={enabled ? `Disable ${label}` : `Enable ${label}`}
        />
      </span>
    </Tooltip>
  )
}
