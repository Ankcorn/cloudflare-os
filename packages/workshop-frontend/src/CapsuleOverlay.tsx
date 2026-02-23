import { useEffect, useRef, type MutableRefObject } from 'react'
import { Typography } from 'antd'
import { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from './AuthContext'
import ResourcePicker, { type SelectableItem } from './ResourcePicker'
import styles from './CapsuleOverlay.module.css'

const { Text } = Typography

export interface CapsuleOverlayProps {
  url: string
  onSelectAccount: (
    accountId: number,
    vendorId: string,
    resource: SupportedResource,
    accountDescription: AccountDescription,
    vendorDescription: VendorDescription,
  ) => void
  onDismiss: () => void
  activeIndex?: number
  onItems?: (items: SelectableItem[]) => void
  activateRef?: MutableRefObject<((index: number) => void) | null>
  below?: boolean
}

// Minimum URL length to trigger showing the overlay (must have at least a hostname char).
const MIN_URL_LENGTH = 'https://x'.length

export default function CapsuleOverlay({ url, onSelectAccount, onDismiss, activeIndex, onItems, activateRef, below }: CapsuleOverlayProps) {
  const { authenticatedApi } = useAuthenticatedApi()
  const overlayRef = useRef<HTMLDivElement>(null)

  // Dismiss on Escape key.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onDismiss()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onDismiss])

  // Don't show if the URL is too short to be meaningful.
  if (url.length < MIN_URL_LENGTH) {
    return null
  }

  return (
    <div ref={overlayRef} className={below ? styles.capsuleOverlayBelow : styles.capsuleOverlay}>
      <Text type="secondary" className={styles.capsuleOverlayHeader}>
        Grant agent access to this resource
      </Text>
      <ResourcePicker
        authenticatedApi={authenticatedApi}
        searchText={url}
        onSelectAccount={onSelectAccount}
        compact
        activeIndex={activeIndex}
        onItems={onItems}
        activateRef={activateRef}
      />
    </div>
  )
}
