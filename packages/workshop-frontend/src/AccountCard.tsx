import { Avatar, Tooltip, Typography } from 'antd'
import { UserOutlined, LinkOutlined } from '@ant-design/icons'
import { AccountDescription, VendorDescription } from '@minions/workshop-shared/gatekeeper'

const { Text } = Typography

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
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        border: `1px solid ${selected ? '#1890ff' : '#d9d9d9'}`,
        borderRadius: 8,
        cursor: onClick && !disabled ? 'pointer' : 'default',
        opacity: disabled ? 0.5 : 1,
        backgroundColor: selected ? '#f0f5ff' : 'transparent',
        transition: 'all 0.2s',
      }}
      onMouseEnter={(e) => {
        if (onClick && !disabled && !selected) {
          e.currentTarget.style.borderColor = '#1890ff'
          e.currentTarget.style.backgroundColor = '#f0f5ff'
        }
      }}
      onMouseLeave={(e) => {
        if (!selected) {
          e.currentTarget.style.borderColor = '#d9d9d9'
          e.currentTarget.style.backgroundColor = 'transparent'
        }
      }}
    >
      {/* Overlapping avatars */}
      <div style={{ position: 'relative', width: 48, height: 40 }}>
        {vendor.logo ? (
          <Avatar
            src={vendor.logo.url}
            size={32}
            style={{ position: 'absolute', left: 0, top: 0 }}
          />
        ) : (
          <Avatar
            size={32}
            icon={<LinkOutlined />}
            style={{ position: 'absolute', left: 0, top: 0 }}
          />
        )}
        {account.avatar?.url ? (
          <Avatar
            src={account.avatar.url}
            size={32}
            style={{ position: 'absolute', left: 16, top: 8, border: '2px solid white' }}
          />
        ) : (
          <Avatar
            size={32}
            icon={<UserOutlined />}
            style={{ position: 'absolute', left: 16, top: 8, border: '2px solid white' }}
          />
        )}
      </div>

      {/* Account info */}
      <div style={{ flex: 1 }}>
        <Text strong>
          {vendor.displayName}
          {account.uniqueName && `: ${account.uniqueName}`}
        </Text>
        {account.displayName && account.uniqueName && (
          <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
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
        title={
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {account.scope.map((scope, i) => (
              <li key={i}>{scope}</li>
            ))}
          </ul>
        }
        placement="right"
      >
        {content}
      </Tooltip>
    )
  }

  return content
}
