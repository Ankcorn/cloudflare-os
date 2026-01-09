import { Modal, message, Typography, Spin } from 'antd'
import { useState, useEffect } from 'react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi, GatekeeperVendorFilter } from '@minions/workshop-shared/api'
import { VendorDescription } from '@minions/workshop-shared/gatekeeper'
import VendorCard from './VendorCard'

const { Text } = Typography

interface ConnectAccountModalProps {
  visible: boolean
  onCancel: () => void
  onInitiated: () => void
  authenticatedApi: RpcStub<AuthenticatedApi>
  /** Optional filter to only show vendors supporting certain features */
  filter?: GatekeeperVendorFilter
}

interface VendorOption {
  id: string
  description: VendorDescription
}

export default function ConnectAccountModal({
  visible,
  onCancel,
  onInitiated,
  authenticatedApi,
  filter,
}: ConnectAccountModalProps) {
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
        const vendorList = await authenticatedApi.listGatekeeperVendors(filter)
        setVendors(vendorList.map(v => ({ id: v.id, description: v.description })))
      } catch (error) {
        console.error('Failed to fetch vendors:', error)
        message.error('Failed to load available services')
      } finally {
        setVendorsLoading(false)
      }
    }

    fetchVendors()
  }, [visible, authenticatedApi, filter])

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
            <VendorCard
              key={vendor.id}
              vendor={vendor.description}
              onClick={() => handleConnect(vendor.id)}
              loading={connecting === vendor.id}
              disabled={connecting !== null && connecting !== vendor.id}
            />
          ))}
        </div>
      )}
    </Modal>
  )
}
