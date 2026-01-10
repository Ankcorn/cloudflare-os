import { Avatar, Typography, Spin } from 'antd'
import { LinkOutlined } from '@ant-design/icons'
import { VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

const { Text } = Typography

export interface VendorCardProps {
  vendor: VendorDescription
  onClick: () => void
  /** Whether this vendor is currently being connected */
  loading?: boolean
  /** Whether this card is disabled (e.g., another vendor is being connected) */
  disabled?: boolean
}

export default function VendorCard({
  vendor,
  onClick,
  loading = false,
  disabled = false,
}: VendorCardProps) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: 16,
        border: '1px solid #d9d9d9',
        borderRadius: 8,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled && !loading ? 0.5 : 1,
        transition: 'all 0.2s',
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          e.currentTarget.style.borderColor = '#1890ff'
          e.currentTarget.style.backgroundColor = '#f0f5ff'
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = '#d9d9d9'
        e.currentTarget.style.backgroundColor = 'transparent'
      }}
    >
      {vendor.logo ? (
        <Avatar src={vendor.logo.url} size={48} />
      ) : (
        <Avatar size={48} icon={<LinkOutlined />} />
      )}
      <div style={{ flex: 1 }}>
        <Text strong style={{ display: 'block', fontSize: 16 }}>
          {vendor.displayName}
        </Text>
        {vendor.url && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {vendor.url}
          </Text>
        )}
      </div>
      {loading && <Spin size="small" />}
    </div>
  )
}
