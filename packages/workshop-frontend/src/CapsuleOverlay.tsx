import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from './AuthContext'
import ResourcePicker, { type SelectableItem } from './ResourcePicker'
import styles from './CapsuleOverlay.module.css'

export interface CapsuleOverlayProps {
  url: string
  onSelectAccount: (
    accountId: number,
    vendorId: string,
    resource: SupportedResource,
    accountDescription: AccountDescription,
    vendorDescription: VendorDescription,
  ) => void
  onRefine?: (newUrl: string, placeholderStart: number, placeholderEnd: number) => void
  onDismiss: () => void
  activeIndex?: number
  onItems?: (items: SelectableItem[]) => void
  activateRef?: MutableRefObject<((index: number) => void) | null>
  // Distance from the bottom of the positioning parent to the line the URL is on, so the panel sits
  // with that line rather than above the whole composer.
  lineOffset?: number
}

// Minimum URL length to trigger showing the overlay (show once the scheme is complete).
const MIN_URL_LENGTH = 'http://'.length

// Gap between the panel and the line it points at. Matches the offset in CapsuleOverlay.module.css.
export const CAPSULE_OVERLAY_GAP = 8

export default function CapsuleOverlay({ url, onSelectAccount, onRefine, onDismiss, activeIndex, onItems, activateRef, lineOffset }: CapsuleOverlayProps) {
  const { authenticatedApi } = useAuthenticatedApi()
  const overlayRef = useRef<HTMLDivElement>(null)
  // A list that fills in row by row moves under the pointer and shuffles what Tab is aimed at, so
  // the panel stays out of the way until there is a list to show.
  const [ready, setReady] = useState(false)
  const onReadyChange = useCallback((value: boolean) => setReady(value), [])

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
    <div
      ref={overlayRef}
      className={`themed-floating-shadow ${styles.capsuleOverlay} ${ready ? '' : 'invisible'}`}
      style={lineOffset === undefined ? undefined : {bottom: lineOffset}}
    >
      <ResourcePicker
        authenticatedApi={authenticatedApi}
        searchText={url}
        onSelectAccount={onSelectAccount}
        onRefine={onRefine}
        onReadyChange={onReadyChange}
        compact
        activeIndex={activeIndex}
        onItems={onItems}
        activateRef={activateRef}
      />
    </div>
  )
}
