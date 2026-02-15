import { useState } from 'react'
import { Typography, Button } from 'antd'
import { CloseOutlined } from '@ant-design/icons'

const { Text } = Typography

const WARNING_TEXT = 'This is an alpha test. All data may be deleted without warning.'

let dismissed = false

export default function AlphaWarning() {
  const [visible, setVisible] = useState(!dismissed)

  if (!visible) return null

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <Text style={{ color: '#d40006', fontSize: 17, fontWeight: 'bold' }}>
        {WARNING_TEXT}
      </Text>
      <Button
        type="text"
        size="small"
        icon={<CloseOutlined />}
        onClick={() => { dismissed = true; setVisible(false) }}
        style={{ color: '#d40006', fontSize: 12 }}
      />
    </span>
  )
}
