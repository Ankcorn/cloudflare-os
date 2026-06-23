import { Switch, Tooltip } from '@cloudflare/kumo'

interface HookToggleProps {
  enabled: boolean
  disabled?: boolean
  onToggle: (enabled: boolean) => void
  size?: 'sm' | 'base' | 'lg'
}

// Toggle used to enable/disable a bound hook. Reused in the Connections tab, the Activity log,
// and inline chat action cards.
export function HookToggle({ enabled, disabled = false, onToggle, size = 'sm' }: HookToggleProps) {
  return (
    <Tooltip content={enabled ? 'Disable this hook.' : 'Enable this hook.'} asChild>
      <span className="inline-flex items-center">
        <Switch
          checked={enabled}
          disabled={disabled}
          size={size}
          onCheckedChange={(checked) => onToggle(checked)}
          aria-label={enabled ? 'Disable hook' : 'Enable hook'}
        />
      </span>
    </Tooltip>
  )
}
