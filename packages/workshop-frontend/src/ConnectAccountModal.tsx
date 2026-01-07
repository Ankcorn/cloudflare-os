import { Modal, message, Typography, Avatar, Spin } from 'antd'
import { useState, useEffect } from 'react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@minions/workshop-shared/api'
import { VendorDescription } from '@minions/workshop-shared/gatekeeper'
import { LinkOutlined } from '@ant-design/icons'

const { Text } = Typography

interface ConnectAccountModalProps {
  visible: boolean
  onCancel: () => void
  onInitiated: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
}

interface VendorOption {
  id: string
  description: VendorDescription
}

export default function ConnectAccountModal({ visible, onCancel, onInitiated, authenticatedApi }: ConnectAccountModalProps) {
  const [connecting, setConnecting] = useState<string | null>(null)
  const [vendors, setVendors] = useState<VendorOption[]>([])
  const [vendorsLoading, setVendorsLoading] = useState(true)

  // Fetch vendors when modal opens
  useEffect(() => {
    if (!visible) {
      setConnecting(null)
      return
    }

    const fetchVendors = async () => {
      setVendorsLoading(true)
      try {
        const vendorList = await authenticatedApi.listGatekeeperVendors()
        setVendors(vendorList.map(v => ({ id: v.id, description: v.description })))
      } catch (error) {
        console.error('Failed to fetch vendors:', error)
        message.error('Failed to load available services')
      } finally {
        setVendorsLoading(false)
      }
    }

    fetchVendors()
  }, [visible, authenticatedApi])

  const handleConnect = async (vendorId: string) => {
    setConnecting(vendorId)
    try {
      const result = await authenticatedApi.connectAccount(vendorId)
      window.open(result.url, '_blank')
      onInitiated()
    } catch (error) {
      console.error('Failed to initiate connection:', error)
      message.error('Failed to start connection flow')
      setConnecting(null)
    }
  }

  return (
    <Modal
      title="Connect Account"
      open={visible}
      onCancel={onCancel}
      footer={null}
      width={500}
    >
      {vendorsLoading ? (
        <div style={{ textAlign: 'center', padding: '32px 0' }}>
          <Spin />
        </div>
      ) : vendors.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '32px 0' }}>
          <Text type="secondary">No services available to connect.</Text>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
          {vendors.map(vendor => (
            <div
              key={vendor.id}
              onClick={() => !connecting && handleConnect(vendor.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: 16,
                border: '1px solid #d9d9d9',
                borderRadius: 8,
                cursor: connecting ? 'not-allowed' : 'pointer',
                opacity: connecting && connecting !== vendor.id ? 0.5 : 1,
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                if (!connecting) {
                  e.currentTarget.style.borderColor = '#1890ff'
                  e.currentTarget.style.backgroundColor = '#f0f5ff'
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = '#d9d9d9'
                e.currentTarget.style.backgroundColor = 'transparent'
              }}
            >
              {vendor.description.logo ? (
                <Avatar src={vendor.description.logo.url} size={48} />
              ) : (
                <Avatar size={48} icon={<LinkOutlined />} />
              )}
              <div style={{ flex: 1 }}>
                <Text strong style={{ display: 'block', fontSize: 16 }}>
                  {vendor.description.displayName}
                </Text>
                {vendor.description.url && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {vendor.description.url}
                  </Text>
                )}
              </div>
              {connecting === vendor.id && <Spin size="small" />}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
