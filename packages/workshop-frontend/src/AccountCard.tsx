import { Text, Tooltip } from '@cloudflare/kumo'
import { User, LinkSimple } from '@phosphor-icons/react'
import { AccountDescription, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import Avatar from './components/Avatar'

export interface AccountCardProps {
  account: AccountDescription
  vendor: VendorDescription
  onClick?: () => void
  /** Show scope tooltip on hover */
  showTooltip?: boolean
  /** Additional content to render on the right side (e.g., delete button) */
  actions?: React.ReactNode
  /** Whether this card is currently selected */
  selected?: boolean
  /** Whether this card is disabled */
  disabled?: boolean
}

export default function AccountCard({
  account,
  vendor,
  onClick,
  showTooltip = false,
  actions,
  selected = false,
  disabled = false,
}: AccountCardProps) {
  const content = (
    <div
      onClick={disabled ? undefined : onClick}
      className={`flex items-center gap-3 px-4 py-3 border rounded-lg transition-all ${
        selected
          ? 'border-kumo-brand bg-kumo-tint'
          : 'border-kumo-line'
      } ${
        onClick && !disabled && !selected
          ? 'cursor-pointer hover:border-kumo-brand hover:bg-kumo-tint'
          : ''
      } ${
        !onClick || disabled ? 'cursor-default' : ''
      } ${
        disabled ? 'opacity-50' : ''
      }`}
    >
      {/* Overlapping avatars */}
      <div className="relative" style={{ width: 48, height: 40 }}>
        <Avatar
          src={vendor.logo?.url}
          size={32}
          fallback={<LinkSimple size={14} />}
          style={{ position: 'absolute', left: 0, top: 0 }}
        />
        <Avatar
          src={account.avatar?.url}
          size={32}
          fallback={<User size={14} />}
          style={{ position: 'absolute', left: 16, top: 8, border: '2px solid var(--color-kumo-base)' }}
        />
      </div>

      {/* Account info */}
      <div className="flex-1">
        <Text variant="body" bold as="span">
          {vendor.displayName}
          {account.uniqueName && `: ${account.uniqueName}`}
        </Text>
        {account.displayName && account.uniqueName && (
          <Text variant="secondary" size="xs" as="span" DANGEROUS_className="block">
            {account.displayName}
          </Text>
        )}
      </div>

      {/* Actions (e.g., delete button) */}
      {actions}
    </div>
  )

  if (showTooltip && account.scope.length > 0) {
    return (
      <Tooltip
        content={
          <ul className="m-0 pl-4">
            {account.scope.map((scope, i) => (
              <li key={i}>{scope}</li>
            ))}
          </ul>
        }
        side="right"
      >
        {content}
      </Tooltip>
    )
  }

  return content
}
