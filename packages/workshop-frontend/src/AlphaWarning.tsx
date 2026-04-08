import { useState } from 'react'
import { Text, Button } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'

const WARNING_TEXT = 'This is an alpha test. All data may be deleted without warning.'

let dismissed = false

export default function AlphaWarning() {
  const [visible, setVisible] = useState(!dismissed)

  if (!visible) return null

  return (
    <span className="inline-flex items-center gap-1.5">
      <Text variant="error" bold as="span" DANGEROUS_className="text-[17px]">
        {WARNING_TEXT}
      </Text>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => { dismissed = true; setVisible(false) }}
        aria-label="Dismiss warning"
      >
        <X size={12} className="text-kumo-danger" />
      </Button>
    </span>
  )
}
