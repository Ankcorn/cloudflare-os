import { useState, useEffect, useRef, useMemo, Fragment, type ReactNode } from 'react'
import { Input, Button, List, Typography, Space, Card, Empty, Spin, message, Modal, Select, Tag, Tooltip } from 'antd'
import { SendOutlined, StopOutlined, MessageOutlined, RobotOutlined, EditOutlined, CheckOutlined, CloseOutlined, DeleteOutlined, CheckCircleOutlined, ReloadOutlined, ExclamationCircleOutlined, PaperClipOutlined } from '@ant-design/icons'
import { RpcStub, RpcTarget } from 'capnweb'
import ReactMarkdown from 'react-markdown'
import * as Y from 'yjs'
import styles from './ChatInterface.module.css'
import {
  Overseer,
  GatekeeperClient,
  AiChatMetadata,
  AiChatMessage,
  AiChatSubscriber,
  AiChatAuthorInfo,
  CapsuleSpecifier,
} from '@gadgets/workshop-shared/api'
import { ResourceDescription } from '@gadgets/workshop-shared/gatekeeper'
import CapsuleOverlay from './CapsuleOverlay'
import type { SelectableItem } from './ResourcePicker'
import NewGatekeeperModal from './NewGatekeeperModal'

const { TextArea } = Input
const { Text, Title, Link } = Typography

// Chat input component with internal state to prevent parent re-renders while typing
const CONSOLE_LOG_SEVERITY_STYLES: Record<string, React.CSSProperties> = {
  error: { backgroundColor: '#fff1f0', borderColor: '#ffa39e', color: '#cf1322' },
  warn:  { backgroundColor: '#fffbe6', borderColor: '#ffe58f', color: '#ad6800' },
  info:  { backgroundColor: '#f5f5f5', borderColor: '#d9d9d9', color: '#595959' },
}

// Internal capsule state tracked within ChatInput (not yet sent).
interface InputCapsule {
  start: number
  length: number
  gatekeeperId: number
  description: ResourceDescription
}

// Matches http:// and https:// URLs in text, stopping at whitespace and common delimiters.
const URL_REGEX = /https?:\/\/[^\s)>\]]+/g

export const ChatInput = ({ createCapsuleGatekeeper, getOverseer, onSend, isAgentActive, models,
    selectedModel, onModelChange,
    pendingConsoleLogCount = 0, consoleLogPreview = '', consoleLogSeverity = 'info',
    onConsumeConsoleLogs = () => '', onDiscardConsoleLogs = () => {},
    newChat = false }: {
  createCapsuleGatekeeper: (accountId: number, url: string) => Promise<RpcStub<GatekeeperClient<any>> | null>
  // Returns an overseer stub, used by the attach modal to create gatekeepers. Can be async
  // to support lazy provisional-gadget creation on the Home page.
  getOverseer: () => Promise<RpcStub<Overseer>> | RpcStub<Overseer>
  onSend: (message: string, modelId: string | null, capsules?: CapsuleSpecifier[]) => void
  isAgentActive: boolean
  models: AiChatAuthorInfo[]
  selectedModel: string | null
  onModelChange: (modelId: string | null) => void
  pendingConsoleLogCount?: number
  consoleLogPreview?: string
  consoleLogSeverity?: 'error' | 'warn' | 'info'
  onConsumeConsoleLogs?: () => string
  onDiscardConsoleLogs?: () => void
  newChat?: boolean
}) => {
  const [inputValue, setInputValue] = useState('')
  const [capsules, setCapsules] = useState<InputCapsule[]>([])
  const [activeUrl, setActiveUrl] = useState<{ text: string, start: number, end: number } | null>(null)
  const [overlayIndex, setOverlayIndex] = useState(0)
  const overlayItemsRef = useRef<SelectableItem[]>([])
  const overlayActivateRef = useRef<((index: number) => void) | null>(null)

  // Attach modal state
  const [attachModalOpen, setAttachModalOpen] = useState(false)
  // Save the cursor position when the attach modal opens, so we can insert the capsule there.
  const attachCursorPosRef = useRef(0)

  // Refs for the mirror div and the textarea wrapper.
  const wrapperRef = useRef<HTMLDivElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)

  // Keep inputValue in a ref so handleCursorChange can read it without re-binding.
  const inputValueRef = useRef(inputValue)
  inputValueRef.current = inputValue
  const capsulesRef = useRef(capsules)
  capsulesRef.current = capsules

  // Sync mirror div size with the textarea via ResizeObserver.
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return

    const textarea = wrapper.querySelector('textarea')
    if (!textarea) return

    const syncMirror = () => {
      const mirror = mirrorRef.current
      if (!mirror) return

      // Copy computed styles from the textarea to the mirror so text layout matches exactly.
      const cs = getComputedStyle(textarea)
      mirror.style.fontFamily = cs.fontFamily
      mirror.style.fontSize = cs.fontSize
      mirror.style.fontWeight = cs.fontWeight
      mirror.style.lineHeight = cs.lineHeight
      mirror.style.letterSpacing = cs.letterSpacing
      mirror.style.padding = cs.padding
      mirror.style.border = `${cs.borderWidth} solid transparent`
      mirror.style.height = `${textarea.offsetHeight}px`
      mirror.style.width = `${textarea.offsetWidth}px`
    }

    // Initial sync.
    syncMirror()

    const observer = new ResizeObserver(syncMirror)
    observer.observe(textarea)

    return () => observer.disconnect()
  })

  // Reset overlay selection when the overlay appears or changes URL.
  useEffect(() => {
    setOverlayIndex(0)
  }, [activeUrl])

  const handleSend = () => {
    if (!inputValue.trim()) return

    if (capsules.length === 0) {
      // No capsules — simple send.
      onSend(inputValue.trim(), selectedModel)
    } else {
      // Build processed message: replace each capsule title with [i] placeholder.
      const sortedCapsules = [...capsules].sort((a, b) => a.start - b.start)
      let processedMsg = inputValue
      let cumulativeShift = 0
      const specifiers: CapsuleSpecifier[] = []

      for (let i = 0; i < sortedCapsules.length; i++) {
        const c = sortedCapsules[i]
        const placeholder = `[${i}]`
        const adjustedStart = c.start + cumulativeShift
        processedMsg = processedMsg.slice(0, adjustedStart) + placeholder
                     + processedMsg.slice(adjustedStart + c.length)
        specifiers.push({
          position: adjustedStart,
          length: placeholder.length,
          gatekeeperId: c.gatekeeperId,
          description: c.description,
        })
        cumulativeShift += placeholder.length - c.length
      }

      onSend(processedMsg.trim(), selectedModel, specifiers)
    }

    setInputValue('')
    setCapsules([])
  }

  const handleAttachLogs = () => {
    const formatted = onConsumeConsoleLogs()
    setInputValue(prev => prev + '\n\n' + formatted)
  }

  // Called when the user selects an account in the CapsuleOverlay.
  // Creates a capsule gatekeeper, fetches its description, and replaces the URL
  // in the input text with the resource title highlighted as a capsule.
  const handleCapsuleCreate = async (accountId: number) => {
    if (!activeUrl) return

    try {
      // Create the capsule gatekeeper.
      const gk = await createCapsuleGatekeeper(accountId, activeUrl.text)
      if (!gk) {
        console.error('Failed to create capsule gatekeeper')
        return
      }

      try {
        // Fetch ID and description in parallel (promise pipelining).
        const [id, description] = await Promise.all([gk.getId(), gk.describe()])

        // Snapshot the activeUrl position before any state updates.
        const urlStart = activeUrl.start
        const urlEnd = activeUrl.end
        // Pad the title with spaces so the mirror highlight has visible interior padding.
        const paddedTitle = ` ${description.title} `
        const lengthDiff = paddedTitle.length - (urlEnd - urlStart)

        // Replace the URL text with the padded title in inputValue.
        setInputValue(prev => prev.slice(0, urlStart) + paddedTitle + prev.slice(urlEnd))

        // Adjust positions of existing capsules and add the new one.
        setCapsules(prev => {
          const adjusted = prev.map(c => {
            if (c.start >= urlEnd) {
              return { ...c, start: c.start + lengthDiff }
            }
            return c
          })
          return [...adjusted, {
            start: urlStart,
            length: paddedTitle.length,
            gatekeeperId: id,
            description,
          }]
        })

        // Clear activeUrl so the overlay dismisses.
        setActiveUrl(null)

        // Move cursor to end of inserted title on next tick.
        requestAnimationFrame(() => {
          const wrapper = wrapperRef.current
          if (!wrapper) return
          const textarea = wrapper.querySelector('textarea')
          if (textarea) {
            const cursorPos = urlStart + paddedTitle.length
            textarea.setSelectionRange(cursorPos, cursorPos)
            textarea.focus()
          }
        })
      } finally {
        gk[Symbol.dispose]()
      }
    } catch (err) {
      console.error('Failed to create capsule:', err)
    }
  }

  // Opens the attach modal, saving the current cursor position so we can insert there later.
  const handleAttachOpen = () => {
    const wrapper = wrapperRef.current
    if (wrapper) {
      const textarea = wrapper.querySelector('textarea')
      if (textarea) {
        attachCursorPosRef.current = textarea.selectionStart ?? inputValueRef.current.length
      } else {
        attachCursorPosRef.current = inputValueRef.current.length
      }
    } else {
      attachCursorPosRef.current = inputValueRef.current.length
    }
    setAttachModalOpen(true)
  }

  // Called by the NewGatekeeperModal when a gatekeeper is created via the attach flow.
  // Inserts a capsule at the previously-saved cursor position.
  const handleAttachCreated = async (gk: RpcStub<GatekeeperClient<any>>) => {
    try {
      // Fetch ID and description in parallel (promise pipelining).
      const [id, description] = await Promise.all([gk.getId(), gk.describe()])

      const insertPos = attachCursorPosRef.current
      // Pad the title with spaces so the mirror highlight has visible interior padding.
      const paddedTitle = ` ${description.title} `

      // Insert the capsule title at the saved cursor position.
      setInputValue(prev => prev.slice(0, insertPos) + paddedTitle + prev.slice(insertPos))

      // Adjust positions of existing capsules that come after the insertion point.
      setCapsules(prev => {
        const adjusted = prev.map(c => {
          if (c.start >= insertPos) {
            return { ...c, start: c.start + paddedTitle.length }
          }
          return c
        })
        return [...adjusted, {
          start: insertPos,
          length: paddedTitle.length,
          gatekeeperId: id,
          description,
        }]
      })

      setAttachModalOpen(false)

      // Move cursor to end of inserted capsule and focus the textarea.
      requestAnimationFrame(() => {
        const wrapper = wrapperRef.current
        if (!wrapper) return
        const textarea = wrapper.querySelector('textarea')
        if (textarea) {
          const cursorPos = insertPos + paddedTitle.length
          textarea.setSelectionRange(cursorPos, cursorPos)
          textarea.focus()
        }
      })
    } finally {
      gk[Symbol.dispose]()
    }
  }

  // Handle text changes: detect if edits overlap any capsule and remove broken ones.
  const handleInputChange = (newValue: string) => {
    const oldValue = inputValueRef.current

    if (capsulesRef.current.length === 0) {
      setInputValue(newValue)
      return
    }

    // Find the region that changed by comparing old and new values.
    let diffStart = 0
    while (diffStart < oldValue.length && diffStart < newValue.length
           && oldValue[diffStart] === newValue[diffStart]) {
      diffStart++
    }

    let oldEnd = oldValue.length
    let newEnd = newValue.length
    while (oldEnd > diffStart && newEnd > diffStart
           && oldValue[oldEnd - 1] === newValue[newEnd - 1]) {
      oldEnd--
      newEnd--
    }

    // The edit replaced oldValue[diffStart..oldEnd) with newValue[diffStart..newEnd).
    const isPureInsertion = oldEnd === diffStart

    // If the insertion (no deletion) landed inside a capsule, reject the edit.
    if (isPureInsertion) {
      for (const capsule of capsulesRef.current) {
        const capsuleEnd = capsule.start + capsule.length
        if (diffStart > capsule.start && diffStart < capsuleEnd) {
          // Reject the edit: reset the textarea DOM directly and restore cursor.
          const wrapper = wrapperRef.current
          const textarea = wrapper?.querySelector('textarea')
          if (textarea) {
            textarea.value = oldValue
            textarea.setSelectionRange(diffStart, diffStart)
          }
          return
        }
      }
    }

    // First pass: identify broken capsules and remove their remaining text from
    // newValue. Process from end to start so removals don't shift earlier positions.
    const broken: InputCapsule[] = []
    for (const capsule of capsulesRef.current) {
      const capsuleEnd = capsule.start + capsule.length
      if (diffStart < capsuleEnd && oldEnd > capsule.start) {
        broken.push(capsule)
      }
    }

    // Apply the user's edit shift to map old capsule positions into newValue.
    // Then remove any remaining capsule text that the user didn't already delete.
    let adjusted = newValue
    const editShift = (newEnd - diffStart) - (oldEnd - diffStart)
    // Sort broken capsules by start position descending so we can splice from the end.
    broken.sort((a, b) => b.start - a.start)
    let extraShift = 0
    for (const capsule of broken) {
      // Map capsule range into newValue coordinates.
      let remStart = capsule.start
      let remEnd = capsule.start + capsule.length
      // The edit replaced old[diffStart..oldEnd) with new[diffStart..newEnd).
      // Portions of the capsule before diffStart are unchanged.
      // Portions within the edit region were already modified by the user's edit.
      // Portions after oldEnd shifted by editShift.
      // We want to remove the parts of the capsule that survived the user's edit.
      if (remEnd <= diffStart) {
        // Capsule is entirely before the edit — shouldn't be broken, skip.
        continue
      }
      if (remStart >= oldEnd) {
        // Capsule is entirely after the edit — shifted in newValue.
        remStart += editShift
        remEnd += editShift
      } else {
        // Capsule overlaps the edit region. Clamp to the parts outside the edit
        // that still exist in newValue, plus the edited region itself.
        // In newValue, the edit region is [diffStart..newEnd).
        // Before the edit: capsule text in [remStart..diffStart) is unchanged.
        // After the edit: capsule text in [oldEnd..capsuleEnd) shifted to [newEnd..newEnd+(capsuleEnd-oldEnd)).
        remStart = Math.min(remStart, diffStart)
        const afterOldEnd = capsule.start + capsule.length - oldEnd
        if (afterOldEnd > 0) {
          remEnd = newEnd + afterOldEnd
        } else {
          remEnd = newEnd
        }
        // Also include any part before diffStart.
        remStart = Math.min(remStart, diffStart)
      }
      const removeLen = remEnd - remStart
      if (removeLen > 0 && remStart < adjusted.length) {
        adjusted = adjusted.slice(0, remStart) + adjusted.slice(Math.min(remEnd, adjusted.length))
        extraShift -= removeLen
      }
    }

    // Second pass: keep non-broken capsules, adjusting positions.
    const totalShift = editShift + extraShift
    const surviving: InputCapsule[] = []
    for (const capsule of capsulesRef.current) {
      const capsuleEnd = capsule.start + capsule.length
      if (diffStart < capsuleEnd && oldEnd > capsule.start) {
        continue // broken
      }
      if (capsule.start >= oldEnd) {
        surviving.push({ ...capsule, start: capsule.start + totalShift })
      } else {
        surviving.push(capsule)
      }
    }

    // Position cursor where the earliest broken capsule was.
    const cursorPos = broken.length > 0
      ? broken[broken.length - 1].start  // broken is sorted descending, last = earliest
      : undefined

    setCapsules(surviving)
    setInputValue(adjusted)

    if (cursorPos !== undefined) {
      requestAnimationFrame(() => {
        const wrapper = wrapperRef.current
        if (!wrapper) return
        const textarea = wrapper.querySelector('textarea')
        if (textarea) {
          textarea.setSelectionRange(cursorPos, cursorPos)
        }
      })
    }
  }

  // Detect whether the cursor is currently inside a URL in the input text.
  // Called on every cursor movement (select, click, keyup).
  const handleCursorChange = () => {
    const wrapper = wrapperRef.current
    if (!wrapper) return

    const textarea = wrapper.querySelector('textarea')
    if (!textarea) return

    const cursorPos = textarea.selectionStart
    const text = inputValueRef.current

    // Find all URL matches in the current text.
    URL_REGEX.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = URL_REGEX.exec(text)) !== null) {
      const start = match.index
      const end = start + match[0].length

      // Cursor is within this URL (inclusive of both endpoints).
      if (cursorPos >= start && cursorPos <= end) {
        // Skip if this region is already a capsule.
        const isInsideCapsule = capsulesRef.current.some(
          c => start >= c.start && end <= c.start + c.length
        )
        if (isInsideCapsule) break

        setActiveUrl(prev =>
          prev && prev.text === match![0] && prev.start === start && prev.end === end
            ? prev
            : { text: match![0], start, end }
        )
        return
      }
    }

    // Cursor is not inside any URL.
    setActiveUrl(null)
  }

  // Build the mirror div content: transparent text with highlighted capsule regions.
  const renderMirrorContent = () => {
    if (capsules.length === 0) {
      // No capsules — mirror is just invisible text (no highlights needed,
      // but we still render it so the ResizeObserver can size it).
      return <span>{inputValue || ' '}</span>
    }

    const sorted = [...capsules].sort((a, b) => a.start - b.start)
    const segments: React.ReactNode[] = []
    let pos = 0

    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i]
      // Text before this capsule.
      if (c.start > pos) {
        segments.push(<span key={`t${i}`}>{inputValue.slice(pos, c.start)}</span>)
      }
      // Capsule highlight.
      segments.push(
        <span key={`c${i}`} className={styles.capsuleHighlight}>
          {inputValue.slice(c.start, c.start + c.length)}
        </span>
      )
      pos = c.start + c.length
    }

    // Remaining text after last capsule.
    if (pos < inputValue.length) {
      segments.push(<span key="tail">{inputValue.slice(pos)}</span>)
    }

    // Ensure at least a space so the div has nonzero height when empty.
    if (segments.length === 0) {
      segments.push(<span key="empty">{' '}</span>)
    }

    return <>{segments}</>
  }

  return (
    <div style={{ padding: '16px', ...(!newChat ? { borderTop: '1px solid #f0f0f0' } : {}) }}>
      <Space direction="vertical" style={{ width: '100%' }} size="small">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Text type="secondary" style={{ fontSize: '12px' }}>Model:</Text>
          <Select
            value={selectedModel}
            onChange={onModelChange}
            style={{ width: 200 }}
            size="small"
            options={[
              { label: '(none)', value: null },
              ...models.map(model => ({ label: model.name, value: model.id }))
            ]}
          />
          {pendingConsoleLogCount > 0 && (
            <Space size={4} style={{ marginLeft: 'auto' }}>
              <Tooltip
                title={<pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: '11px', maxHeight: '300px', overflow: 'auto' }}>{consoleLogPreview}</pre>}
                placement="topRight"
                overlayStyle={{ maxWidth: '500px' }}
              >
                <Button
                  size="small"
                  onClick={handleAttachLogs}
                  style={{ ...CONSOLE_LOG_SEVERITY_STYLES[consoleLogSeverity], borderWidth: '1px', borderStyle: 'solid' }}
                >
                  Attach {pendingConsoleLogCount} captured log{pendingConsoleLogCount !== 1 ? 's' : ''}
                </Button>
              </Tooltip>
              <Button
                size="small"
                type="text"
                onClick={onDiscardConsoleLogs}
                style={{ padding: '0 4px', minWidth: 0 }}
              >
                <CloseOutlined style={{ fontSize: '10px' }} />
              </Button>
            </Space>
          )}
          <Tooltip title="Attach resource">
            <Button
              size="small"
              type="text"
              icon={<PaperClipOutlined />}
              onClick={handleAttachOpen}
              style={pendingConsoleLogCount > 0 ? {} : { marginLeft: 'auto' }}
            />
          </Tooltip>
        </div>
        <div style={{ display: 'flex', width: '100%' }}>
          <div ref={wrapperRef} className={styles.capsuleInputWrapper}>
            {/* Capsule overlay — floats above (or below in newChat mode) the textarea when cursor is in a URL */}
            {activeUrl && (
              <CapsuleOverlay
                url={activeUrl.text}
                onSelectAccount={(accountId) => {
                  handleCapsuleCreate(accountId)
                }}
                onDismiss={() => setActiveUrl(null)}
                activeIndex={overlayIndex}
                onItems={(items) => { overlayItemsRef.current = items }}
                activateRef={overlayActivateRef}
                below={newChat}
              />
            )}
            {/* Mirror div — sits behind the textarea, renders capsule highlights */}
            <div ref={mirrorRef} className={styles.capsuleMirror} aria-hidden="true">
              {renderMirrorContent()}
            </div>
            <TextArea
              value={inputValue}
              onChange={(e) => {
                handleInputChange(e.target.value)
                // Re-check URL detection after text changes (cursor position updates on next tick).
                requestAnimationFrame(handleCursorChange)
              }}
              onSelect={handleCursorChange}
              onClick={handleCursorChange}
              onKeyUp={handleCursorChange}
              placeholder={
                isAgentActive
                  ? 'Waiting for agent to finish...'
                  : 'Type your message...'
              }
              autoSize={newChat ? { minRows: 4, maxRows: 12 } : { minRows: 1, maxRows: 4 }}
              onKeyDown={(e) => {
                if (activeUrl && overlayItemsRef.current.length > 0) {
                  const count = overlayItemsRef.current.length
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setOverlayIndex(i => (i + 1) % count)
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setOverlayIndex(i => (i - 1 + count) % count)
                  } else if (e.key === 'Tab') {
                    e.preventDefault()
                    overlayActivateRef.current?.(overlayIndex)
                  }
                }
              }}
              onPressEnter={(e) => {
                if (e.shiftKey) return
                e.preventDefault()
                if (!isAgentActive) handleSend()
              }}
              style={{
                background: 'transparent', position: 'relative', zIndex: 1,
                ...(newChat ? {} : { borderTopRightRadius: 0, borderBottomRightRadius: 0 }),
              }}
            />
          </div>
          {!newChat && (
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={handleSend}
              disabled={!inputValue.trim() || isAgentActive}
              style={{
                borderTopLeftRadius: 0,
                borderBottomLeftRadius: 0,
                height: 'auto',
                alignSelf: 'stretch',
              }}
            >
              Send
            </Button>
          )}
        </div>
        {newChat && (
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={handleSend}
            disabled={!inputValue.trim()}
            block
            size="large"
          >
            Start Chat
          </Button>
        )}
      </Space>
      <NewGatekeeperModal
        open={attachModalOpen}
        onClose={() => setAttachModalOpen(false)}
        getOverseer={getOverseer}
        onCreated={handleAttachCreated}
      />
    </div>
  )
}

// Helper to compute the state of messages (merged/reverted status and active changes)
interface MessageState {
  // Map from sequence number to status for change messages
  changeStatus: Map<number, 'pending' | 'merged' | 'reverted'>

  // Map from merge/revert sequence to the timestamp they reference
  mergeTimestamps: Map<number, Date>     // sequence -> timestamp of merged-through message
  revertTimestamps: Map<number, Date>    // sequence -> timestamp of reverted-from message

  // The accumulated unmerged/unreverted changes (for the proposed changes view)
  activeChanges: Uint8Array[]
}

function computeMessageStates(messages: AiChatMessage[]): MessageState {
  const changeStatus = new Map<number, 'pending' | 'merged' | 'reverted'>()
  const mergeTimestamps = new Map<number, Date>()
  const revertTimestamps = new Map<number, Date>()

  // Track active updates as we scan (for proposed changes computation)
  let updates: {sequence: number, update: Uint8Array}[] = []

  for (let msg of messages) {
    if (msg.type === "changes") {
      updates.push({sequence: msg.sequence, update: msg.update})
      changeStatus.set(msg.sequence, 'pending')

    } else if (msg.type === "merge") {
      // Mark changes as merged and drop from active set
      while (updates.length > 0 && updates[0].sequence <= msg.mergeThrough) {
        const merged = updates.shift()!
        changeStatus.set(merged.sequence, 'merged')
      }
      // Find timestamp for the merged-through message
      const refMsg = messages.find(m => m.sequence === msg.mergeThrough)
      if (refMsg) {
        mergeTimestamps.set(msg.sequence, refMsg.timestamp)
      }

    } else if (msg.type === "revert") {
      // Mark changes as reverted and drop from active set
      while (updates.length > 0 && updates[updates.length - 1].sequence >= msg.revertFrom) {
        const reverted = updates.pop()!
        changeStatus.set(reverted.sequence, 'reverted')
      }
      // Find timestamp for the reverted-from message
      const refMsg = messages.find(m => m.sequence === msg.revertFrom)
      if (refMsg) {
        revertTimestamps.set(msg.sequence, refMsg.timestamp)
      }
    }
  }

  return {
    changeStatus,
    mergeTimestamps,
    revertTimestamps,
    activeChanges: updates.map(u => u.update)
  }
}

interface ChatInterfaceProps {
  overseer: RpcStub<Overseer>
  selectedChatId: number | null
  onNavigateToChat: (chatId: number | null, options?: { replace?: boolean }) => void
  onProposedChangesChange?: (proposedChanges: Uint8Array | undefined) => void
  onFileEdited?: (filename: string) => void
  pendingConsoleLogCount: number
  consoleLogPreview: string
  consoleLogSeverity: 'error' | 'warn' | 'info'
  onConsumeConsoleLogs: () => string
  onDiscardConsoleLogs: () => void
  hideTitleBar?: boolean
  onChatCountChange?: (count: number, hasChatZero: boolean) => void
  onAgentActiveChange?: (chatId: number, isActive: boolean) => void
}

// Client-side cache for chats and messages (survives reconnects)
interface ChatCache {
  chats: Map<number, AiChatMetadata>
  messages: Map<number, AiChatMessage[]>
  lastMessageTimestamp: Date | null
}

// Render a text segment as inline markdown, preserving leading/trailing whitespace
// that CommonMark paragraph parsing would otherwise strip.
function renderInlineMarkdown(text: string, key: string): ReactNode {
  const leading = text.length - text.trimStart().length
  const trailing = text.length - text.trimEnd().length
  if (leading >= text.length) {
    // All whitespace — render directly.
    return <Fragment key={key}>{text}</Fragment>
  }
  return <Fragment key={key}>
    {leading > 0 && text.slice(0, leading)}
    <ReactMarkdown skipHtml={true}
      components={{ p: ({children}) => <>{children}</> }}>
      {text.slice(leading, trailing > 0 ? text.length - trailing : undefined)}
    </ReactMarkdown>
    {trailing > 0 && text.slice(text.length - trailing)}
  </Fragment>
}

// Render a message that may contain capsule placeholders. Splits the message at
// capsule positions and interleaves ReactMarkdown text segments with capsule pills.
function renderMessageWithCapsules(message: string, capsules: CapsuleSpecifier[]) {
  const sorted = [...capsules].sort((a, b) => a.position - b.position)
  const segments: React.ReactNode[] = []
  let pos = 0

  for (let i = 0; i < sorted.length; i++) {
    const capsule = sorted[i]

    // Text before this capsule.
    if (capsule.position > pos) {
      segments.push(renderInlineMarkdown(message.slice(pos, capsule.position), `t${i}`))
    }

    // Capsule pill.
    segments.push(
      <Tooltip key={`c${i}`} title={
        <a href={capsule.description.url} target="_blank" rel="noopener noreferrer"
          style={{ color: 'inherit' }}>
          {capsule.description.url}
        </a>
      }>
        <span className={styles.capsulePill}>
          {capsule.description.title}
        </span>
      </Tooltip>
    )

    pos = capsule.position + capsule.length
  }

  // Remaining text after last capsule.
  if (pos < message.length) {
    segments.push(renderInlineMarkdown(message.slice(pos), 'tail'))
  }

  return <>{segments}</>
}

function ChatInterface({ overseer, selectedChatId, onNavigateToChat, onProposedChangesChange, onFileEdited, pendingConsoleLogCount, consoleLogPreview, consoleLogSeverity, onConsumeConsoleLogs, onDiscardConsoleLogs, hideTitleBar, onChatCountChange, onAgentActiveChange }: ChatInterfaceProps) {
  // Persistent cache that survives reconnects
  const cacheRef = useRef<ChatCache>({
    chats: new Map(),
    messages: new Map(),
    lastMessageTimestamp: null
  })

  // UI state
  const [_isSubscribed, setIsSubscribed] = useState(false)
  const [chatListReady, setChatListReady] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [updateCounter, setUpdateCounter] = useState(0) // Force re-render when cache updates
  const [proposedChangesVersion, setProposedChangesVersion] = useState(0) // Incremented only for change-affecting messages
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleInput, setTitleInput] = useState('')
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(new Set())
  const [expandedReasoning, setExpandedReasoning] = useState<Set<string>>(new Set())
  const [expandedActions, setExpandedActions] = useState<Set<number>>(new Set())
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set())
  const [processingActions, setProcessingActions] = useState<Set<number>>(new Set())
  const [availableModels, setAvailableModels] = useState<AiChatAuthorInfo[]>([])
  const [selectedModel, setSelectedModel] = useState<string | null>(null)

  // Track which tool calls we've already processed for file selection
  const processedToolCallsRef = useRef<Set<string>>(new Set())

  // Refs for accessing current values in subscriber callbacks
  const selectedChatIdRef = useRef<number | null>(null)
  const onNavigateToChatRef = useRef(onNavigateToChat)
  onNavigateToChatRef.current = onNavigateToChat

  // Subscription stub (wrapped in object for useState)
  const subscriptionRef = useRef<RpcStub<{}> | null>(null)

  // Ref for auto-scrolling messages
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Force a re-render when cache is updated
  const forceUpdate = () => setUpdateCounter(prev => prev + 1)

  // Get sorted list of chats from cache
  const chatList = Array.from(cacheRef.current.chats.values())
    .sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime())

  // Notify parent when chat list changes. Gated on chatListReady so that we
  // don't report 0 from the empty initial cache before listChats() has completed.
  const onChatCountChangeRef = useRef(onChatCountChange)
  onChatCountChangeRef.current = onChatCountChange
  const hasChatZero = cacheRef.current.chats.has(0)
  useEffect(() => {
    if (chatListReady) {
      onChatCountChangeRef.current?.(chatList.length, hasChatZero)
    }
  }, [chatList.length, chatListReady, hasChatZero])

  // Get messages for selected chat (filter out any undefined slots in sparse array)
  // Memoized to prevent creating new array on every render
  const currentMessages = useMemo(() => {
    if (selectedChatId === null) return []
    return (cacheRef.current.messages.get(selectedChatId) || []).filter(msg => msg !== undefined)
  }, [selectedChatId, updateCounter])

  // Get metadata for selected chat
  const currentChatMetadata = selectedChatId !== null
    ? cacheRef.current.chats.get(selectedChatId)
    : null

  const isAgentActive = !!currentChatMetadata?.activeAgent
  const activeAgent = currentChatMetadata?.activeAgent

  // Notify parent when agent active state changes
  const onAgentActiveChangeRef = useRef(onAgentActiveChange)
  onAgentActiveChangeRef.current = onAgentActiveChange
  const prevIsAgentActiveRef = useRef(isAgentActive)
  useEffect(() => {
    if (selectedChatId !== null && isAgentActive !== prevIsAgentActiveRef.current) {
      prevIsAgentActiveRef.current = isAgentActive
      onAgentActiveChangeRef.current?.(selectedChatId, isAgentActive)
    }
  }, [isAgentActive, selectedChatId])

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [currentMessages])

  // Initialize title input when selecting a chat
  useEffect(() => {
    if (currentChatMetadata) {
      setTitleInput(currentChatMetadata.title)
    }
  }, [currentChatMetadata?.title])

  // Update selected model when switching chats
  useEffect(() => {
    if (selectedChatId === null) {
      // For new chats, use localStorage or first model
      const lastSelectedModel = localStorage.getItem('lastSelectedModel')
      if (lastSelectedModel && availableModels.some(m => m.id === lastSelectedModel)) {
        setSelectedModel(lastSelectedModel)
      } else if (availableModels.length > 0) {
        setSelectedModel(availableModels[0].id)
      }
    } else {
      // For existing threads:
      // 1. If an AI agent is currently active, use that agent's model
      if (activeAgent) {
        setSelectedModel(activeAgent.id)
      } else {
        // 2. Otherwise, check the last message in the thread
        const messageMessages = currentMessages.filter(msg => msg.type === 'message')
        if (messageMessages.length > 0) {
          const lastMessage = messageMessages[messageMessages.length - 1]
          if (lastMessage.author.type === 'agent') {
            // Last message was from AI, use that model
            setSelectedModel(lastMessage.author.id)
          } else {
            // Last message was from human with no AI responding, so it must have been sent with null model
            setSelectedModel(null)
          }
        } else {
          // No messages yet, set to null
          setSelectedModel(null)
        }
      }
    }
  }, [selectedChatId, availableModels, currentMessages, activeAgent])

  // Keep the ref in sync with selectedChatId state
  useEffect(() => {
    selectedChatIdRef.current = selectedChatId
  }, [selectedChatId])



  // Detect when files are edited via tool calls and notify parent
  useEffect(() => {
    if (!onFileEdited || selectedChatId === null) return

    // Look through all messages for editFile tool calls
    currentMessages.forEach(msg => {
      if (msg.type === 'message' && msg.toolCalls) {
        msg.toolCalls.forEach(toolCall => {
          // If we haven't processed this tool call yet and it's an editFile
          if (!processedToolCallsRef.current.has(toolCall.toolCallId) &&
              toolCall.toolName === 'editFile') {
            // Mark as processed
            processedToolCallsRef.current.add(toolCall.toolCallId)
            // Notify parent
            onFileEdited(toolCall.input.filename)
          }
        })
      }
    })
  }, [currentMessages, selectedChatId, onFileEdited])

  // Notify parent when proposed changes change for the selected chat.
  // Only recomputes when proposedChangesVersion changes (i.e. a "changes", "merge",
  // or "revert" message arrives), NOT on every message.
  useEffect(() => {
    if (!currentChatMetadata?.hasProposedChanges) {
      onProposedChangesChange?.(undefined)
      return
    }

    // Read messages directly from the cache (always current) rather than using the
    // memoized currentMessages, so we don't need it as a dependency.
    const messages = selectedChatId !== null
      ? (cacheRef.current.messages.get(selectedChatId) || []).filter(msg => msg !== undefined)
      : []
    const { activeChanges } = computeMessageStates(messages)

    if (activeChanges.length === 0) {
      onProposedChangesChange?.(undefined)
      return
    }

    const mergedUpdate = activeChanges.length === 1
      ? activeChanges[0]
      : Y.mergeUpdatesV2(activeChanges)

    onProposedChangesChange?.(mergedUpdate)
  }, [currentChatMetadata?.hasProposedChanges, proposedChangesVersion, selectedChatId, onProposedChangesChange])

  // Proper class implementation of AiChatSubscriber
  // This is necessary so the server receives a single stub for the object,
  // not separate stubs for each method
  class ChatSubscriberImpl extends RpcTarget implements AiChatSubscriber{
    metadata(chat: AiChatMetadata) {
      cacheRef.current.chats.set(chat.id, chat)
      forceUpdate()
    }

    deleted(chatId: number) {
      // Remove from cache
      cacheRef.current.chats.delete(chatId)
      cacheRef.current.messages.delete(chatId)

      // If currently viewing this chat, go back to list
      // Use replace to prevent browser-back returning to the deleted chat
      if (selectedChatIdRef.current === chatId) {
        onNavigateToChatRef.current(null, { replace: true })
      }

      forceUpdate()
    }

    message(msg: AiChatMessage) {
      // Use sequence number as index to make this idempotent
      // This handles both duplicate subscriptions (React strict mode) and race conditions

      // Get or initialize messages array for this chat
      let messages = cacheRef.current.messages.get(msg.chatId)
      if (!messages) {
        messages = []
        cacheRef.current.messages.set(msg.chatId, messages)
      }

      // Set message at sequence index (idempotent)
      messages[msg.sequence] = msg

      // Update last message timestamp
      if (!cacheRef.current.lastMessageTimestamp ||
          msg.timestamp > cacheRef.current.lastMessageTimestamp) {
        cacheRef.current.lastMessageTimestamp = msg.timestamp
      }

      // Only trigger proposed-changes recomputation for message types that affect the code.
      // "merge" is excluded: it reclassifies changes from proposed to committed but doesn't
      // change the total code (committed + proposed). The hasProposedChanges metadata
      // dependency handles the transition when all changes are merged.
      if (msg.type === "changes" || msg.type === "revert") {
        setProposedChangesVersion(prev => prev + 1)
      }

      forceUpdate()
    }
  }

  // Keep stable subscriber instance across re-renders
  const subscriberRef = useRef(new ChatSubscriberImpl())

  // Subscribe to chat updates
  useEffect(() => {
    let isMounted = true

    const subscribe = async () => {
      try {
        // Subscribe using startAfter if we have a last message timestamp
        const startAfter = cacheRef.current.lastMessageTimestamp || undefined

        // Don't await - subscribeToChat returns a promise that doesn't resolve until disconnect
        // Store the promise itself as the subscription
        // Pass the subscriber instance (which is now a proper class instance)
        const subscription = overseer.subscribeToChat(
          subscriberRef.current,
          startAfter
        )

        subscriptionRef.current = subscription

        if (isMounted) {
          setIsSubscribed(true)

          // After subscribing, load the list of chats and models
          // This is safe because subscription will catch any new activity
          const [chats, models] = await Promise.all([
            overseer.listChats(),
            overseer.listModels()
          ])

          chats.forEach(chat => {
            cacheRef.current.chats.set(chat.id, chat)
          })
          setChatListReady(true)

          setAvailableModels(models)

          // Set default model: first try localStorage, then fall back to first model
          const lastSelectedModel = localStorage.getItem('lastSelectedModel')
          if (lastSelectedModel && models.some(m => m.id === lastSelectedModel)) {
            setSelectedModel(lastSelectedModel)
          } else if (models.length > 0) {
            setSelectedModel(models[0].id)
          }

          forceUpdate()
        }
      } catch (err) {
        console.error('Failed to subscribe to chats:', err)
      }
    }

    subscribe()

    // Set up reconnection handling
    overseer.onRpcBroken?.((error) => {
      console.warn('RPC connection broken:', error)
      setIsSubscribed(false)
      // Cache persists, component will get new overseer prop and resubscribe
    })

    return () => {
      isMounted = false
      if (subscriptionRef.current) {
        subscriptionRef.current[Symbol.dispose]()
      }
      // Note: subscriberRef.current stays alive for potential resubscription
    }
  }, [overseer])

  // Reset per-chat UI state when selectedChatId changes
  useEffect(() => {
    setExpandedToolCalls(new Set())
    setExpandedReasoning(new Set())
    setExpandedActions(new Set())
    setExpandedErrors(new Set())
    processedToolCallsRef.current = new Set()
    setIsEditingTitle(false)
  }, [selectedChatId])

  // Load chat history when selectedChatId changes to a non-null value
  useEffect(() => {
    if (selectedChatId === null) return

    // If we don't have messages for this chat yet, load them
    if (!cacheRef.current.messages.has(selectedChatId)) {
      let cancelled = false
      setIsLoading(true)

      ;(async () => {
        try {
          const history = await overseer.getChatHistory(selectedChatId)
          if (cancelled) return

          // Get or initialize messages array for this chat
          let messages = cacheRef.current.messages.get(selectedChatId)
          if (!messages) {
            messages = []
            cacheRef.current.messages.set(selectedChatId, messages)
          }

          // Populate using sequence numbers as indices
          // If subscription already added some messages, this will fill in the gaps
          // (and harmlessly overwrite any that match, since content is identical)
          history.forEach(msg => {
            messages[msg.sequence] = msg
          })

          // Update last message timestamp if needed
          if (history.length > 0) {
            const lastMsg = history[history.length - 1]
            if (!cacheRef.current.lastMessageTimestamp ||
                lastMsg.timestamp > cacheRef.current.lastMessageTimestamp) {
              cacheRef.current.lastMessageTimestamp = lastMsg.timestamp
            }
          }

          // History may contain change-affecting messages that the subscriber
          // didn't deliver (they predated the subscription). Bump the version so
          // the proposed-changes effect re-evaluates with the loaded messages.
          setProposedChangesVersion(prev => prev + 1)
          forceUpdate()
        } catch (err) {
          console.error('Failed to load chat history:', err)
          // If loading fails (e.g., invalid chat ID), navigate back to chat list
          if (!cancelled) {
            onNavigateToChatRef.current(null, { replace: true })
          }
        } finally {
          if (!cancelled) {
            setIsLoading(false)
          }
        }
      })()

      return () => { cancelled = true }
    }
  // LSP reports an error here, but tsc does not.
  // The LSP error is due to bugs that need to be fixed in Cap'n Web.
  }, [selectedChatId, overseer])

  // Handle sending a message (always called from ChatInput with explicit messageText)
  const handleSend = async (messageText?: string, modelId?: string | null,
      capsules?: CapsuleSpecifier[]) => {
    const message = messageText?.trim()
    if (!message) return

    // Use provided modelId or fall back to selectedModel
    const model = modelId !== undefined ? modelId : selectedModel

    try {
      if (selectedChatId === null) {
        // Create a new chat (with optional capsules).
        const newChatId = await overseer.newChat(message, model, capsules)
        onNavigateToChatRef.current(newChatId)
      } else {
        // Send message to existing chat.
        await overseer.sendChatMessage(selectedChatId, message, model, capsules || undefined)
      }
    } catch (err) {
      console.error('Failed to send message:', err)
    }
  }

  // Handle model change
  const handleModelChange = (modelId: string | null) => {
    setSelectedModel(modelId)
    if (modelId !== null) {
      localStorage.setItem('lastSelectedModel', modelId)
    }
  }

  // Handle stopping the agent
  const handleStop = async () => {
    if (selectedChatId === null) return

    try {
      await overseer.stopAgent(selectedChatId)
    } catch (err) {
      console.error('Failed to stop agent:', err)
    }
  }

  // Handle saving chat title
  const handleSaveChatTitle = async () => {
    if (selectedChatId === null || !titleInput.trim()) {
      return
    }

    try {
      await overseer.setChatTitle(selectedChatId, titleInput.trim())

      // Update the cache with the new title
      const chat = cacheRef.current.chats.get(selectedChatId)
      if (chat) {
        cacheRef.current.chats.set(selectedChatId, { ...chat, title: titleInput.trim() })
        forceUpdate()
      }

      setIsEditingTitle(false)
      message.success('Chat title updated successfully')
    } catch (err) {
      console.error('Failed to update chat title:', err)
      message.error('Failed to update chat title')
    }
  }

  // Handle canceling title edit
  const handleCancelTitleEdit = () => {
    setTitleInput(currentChatMetadata?.title || '')
    setIsEditingTitle(false)
  }

  // Handle deleting a chat
  const handleDeleteChat = () => {
    if (selectedChatId === null || !currentChatMetadata) return

    Modal.confirm({
      title: 'Delete Chat',
      content: `Are you sure you want to delete "${currentChatMetadata.title}"? This action cannot be undone.`,
      okText: 'Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          await overseer.deleteChat(selectedChatId)
          message.success('Chat deleted successfully')
          // The subscription callback will handle navigation back to list
        } catch (err) {
          console.error('Failed to delete chat:', err)
          message.error('Failed to delete chat')
        }
      }
    })
  }

  // Handle merging changes up to a specific sequence number
  const handleMergeChanges = async (mergeThrough: number) => {
    if (selectedChatId === null) return

    try {
      await overseer.mergeChanges(selectedChatId, mergeThrough)
      message.success('Changes merged successfully')
    } catch (err) {
      console.error('Failed to merge changes:', err)
      message.error('Failed to merge changes')
    }
  }

  // Handle reverting changes from a specific sequence number onward
  const handleRevertChanges = async (revertFrom: number) => {
    if (selectedChatId === null) return

    try {
      await overseer.revertChanges(selectedChatId, revertFrom)
      message.success('Changes reverted successfully')
    } catch (err) {
      console.error('Failed to revert changes:', err)
      message.error('Failed to revert changes')
    }
  }

  // Handle approving an action from the chat thread
  const handleApproveAction = async (actionId: number) => {
    setProcessingActions(prev => new Set(prev).add(actionId))
    try {
      await overseer.approveAction(actionId)
      // Optimistically update the local message cache
      if (selectedChatId !== null) {
        const messages = cacheRef.current.messages.get(selectedChatId)
        if (messages) {
          for (const msg of messages) {
            if (msg?.type === 'action' && msg.actionId === actionId && msg.actionLog) {
              msg.actionLog.state = 'approved'
              if (msg.actionLog.type === 'action') {
                msg.actionLog.appliedAt = new Date()
              }
              break
            }
          }
        }
      }
      forceUpdate()
    } catch (err) {
      console.error('Failed to approve action:', err)
      message.error('Failed to approve action')
    } finally {
      setProcessingActions(prev => {
        const next = new Set(prev)
        next.delete(actionId)
        return next
      })
    }
  }

  // Handle rejecting an action from the chat thread
  const handleRejectAction = async (actionId: number) => {
    setProcessingActions(prev => new Set(prev).add(actionId))
    try {
      await overseer.rejectAction(actionId)
      // Optimistically update the local message cache
      if (selectedChatId !== null) {
        const messages = cacheRef.current.messages.get(selectedChatId)
        if (messages) {
          for (const msg of messages) {
            if (msg?.type === 'action' && msg.actionId === actionId && msg.actionLog) {
              msg.actionLog.state = 'rejected'
              break
            }
          }
        }
      }
      forceUpdate()
    } catch (err) {
      console.error('Failed to reject action:', err)
      message.error('Failed to reject action')
    } finally {
      setProcessingActions(prev => {
        const next = new Set(prev)
        next.delete(actionId)
        return next
      })
    }
  }

  // Toggle tool call expansion
  const toggleToolCallExpansion = (toolCallId: string) => {
    setExpandedToolCalls(prev => {
      const next = new Set(prev)
      if (next.has(toolCallId)) {
        next.delete(toolCallId)
      } else {
        next.add(toolCallId)
      }
      return next
    })
  }

  // Toggle action description expansion
  const toggleActionExpansion = (actionId: number) => {
    setExpandedActions(prev => {
      const next = new Set(prev)
      if (next.has(actionId)) {
        next.delete(actionId)
      } else {
        next.add(actionId)
      }
      return next
    })
  }

  // Toggle reasoning expansion
  const toggleReasoningExpansion = (messageKey: string) => {
    setExpandedReasoning(prev => {
      const next = new Set(prev)
      if (next.has(messageKey)) {
        next.delete(messageKey)
      } else {
        next.add(messageKey)
      }
      return next
    })
  }

  // Toggle error message expansion
  const toggleErrorExpansion = (messageKey: string) => {
    setExpandedErrors(prev => {
      const next = new Set(prev)
      if (next.has(messageKey)) {
        next.delete(messageKey)
      } else {
        next.add(messageKey)
      }
      return next
    })
  }

  // Handle retrying the agent after an error
  const handleRetry = async () => {
    if (selectedChatId === null || selectedModel === null) return

    try {
      await overseer.retryAgent(selectedChatId, selectedModel)
    } catch (err) {
      console.error('Failed to retry agent:', err)
      message.error('Failed to retry agent')
    }
  }

  // Compute message states (merged/reverted status)
  const messageStates = useMemo(
    () => computeMessageStates(currentMessages),
    [currentMessages]
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Chat list or new chat prompt */}
      {selectedChatId === null ? (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '24px',
          overflowY: 'auto'
        }}>
          {/* New chat input at top/center */}
          <div style={{ width: '100%', maxWidth: '600px', marginBottom: '32px' }}>
            <Card>
              <Title level={4} style={{ margin: '0 0 16px', textAlign: 'center' }}>
                Start a New Chat
              </Title>
              <ChatInput
                createCapsuleGatekeeper={(accountId, url) => overseer.newGatekeeper(accountId, url)}
                getOverseer={() => overseer}
                onSend={handleSend}
                isAgentActive={false}
                models={availableModels}
                selectedModel={selectedModel}
                onModelChange={handleModelChange}
                newChat
              />
            </Card>
          </div>

          {/* Past chats list */}
          {chatList.length > 0 && (
            <div style={{ width: '100%', maxWidth: '600px' }}>
              <Title level={5} style={{ marginBottom: '16px' }}>
                Recent Chats
              </Title>
              <List
                dataSource={chatList}
                renderItem={(chat) => (
                  <List.Item
                    onClick={() => onNavigateToChat(chat.id)}
                    style={{
                      cursor: 'pointer',
                      padding: '12px',
                      ...(chat.spawnerName ? { backgroundColor: '#f0f5ff', borderLeft: '3px solid #597ef7' } : {})
                    }}
                  >
                    <List.Item.Meta
                      avatar={chat.spawnerName
                        ? <RobotOutlined style={{ fontSize: '20px', color: '#597ef7' }} />
                        : <MessageOutlined style={{ fontSize: '20px' }} />}
                      title={
                        <Space>
                          <Text strong>{chat.title}</Text>
                          {chat.spawnerName && (
                            <Tag color="blue">{chat.spawnerName}</Tag>
                          )}
                          {chat.activeAgent && (
                            <Spin size="small" />
                          )}
                        </Space>
                      }
                      description={
                        <Space direction="vertical" size={0}>
                          <Text type="secondary">
                            Last active: {chat.lastActive.toLocaleString()}
                          </Text>
                          {(chat.totalTokens != null || chat.totalCost != null) && (
                            <Text type="secondary" style={{ fontSize: '12px' }}>
                              {[
                                chat.totalTokens != null
                                  ? `${chat.totalTokens.toLocaleString()} tokens`
                                  : null,
                                chat.totalCost != null
                                  ? `$${chat.totalCost.toFixed(4)}`
                                  : null,
                              ].filter(Boolean).join(' · ')}
                            </Text>
                          )}
                        </Space>
                      }
                    />
                  </List.Item>
                )}
              />
            </div>
          )}

          {chatList.length === 0 && (
            <Empty
              description="No chats yet. Start a conversation above!"
              style={{ marginTop: '32px' }}
            />
          )}
        </div>
      ) : (
        <>
          {/* Chat header - hidden in simple chat mode */}
          {!hideTitleBar && <div style={{
            padding: '16px',
            borderBottom: '1px solid #f0f0f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}>
            <Space>
              {isEditingTitle ? (
                <Space.Compact>
                  <Input
                    value={titleInput}
                    onChange={(e) => setTitleInput(e.target.value)}
                    onPressEnter={handleSaveChatTitle}
                    placeholder="Enter chat title"
                    style={{ width: 200 }}
                    autoFocus
                  />
                  <Button
                    icon={<CheckOutlined />}
                    onClick={handleSaveChatTitle}
                    type="primary"
                    disabled={!titleInput.trim()}
                  />
                  <Button
                    icon={<CloseOutlined />}
                    onClick={handleCancelTitleEdit}
                  />
                </Space.Compact>
              ) : (
                <>
                  <Title level={5} style={{ margin: 0 }}>
                    {currentChatMetadata?.title || 'Chat'}
                  </Title>
                  <Button
                    icon={<EditOutlined />}
                    onClick={() => setIsEditingTitle(true)}
                    type="text"
                    size="small"
                  />
                </>
              )}
            </Space>
            <Space>
              <Button
                icon={<DeleteOutlined />}
                onClick={handleDeleteChat}
                danger
                type="text"
                title="Delete Chat"
              />
            </Space>
          </div>}

          {/* Messages area */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column'
          }}>
            {isLoading ? (
              <div style={{ textAlign: 'center', padding: '32px' }}>
                <Spin />
              </div>
            ) : (
              <>
                {currentMessages.map((msg, idx) => (
                  <div
                    key={`${msg.chatId}-${msg.sequence}`}
                    style={{
                      width: '100%',
                      padding: '16px 24px',
                    }}
                  >
                    {msg.type === 'message' ? (
                      <div style={{
                        maxWidth: '800px',
                        margin: '0 auto',
                        ...(msg.author.type === 'user' ? {
                          backgroundColor: '#f5f5f5',
                          borderRadius: '8px',
                          padding: '12px 16px',
                        } : {})
                      }}>
                        <Space direction="vertical" size="small" style={{ width: '100%' }}>
                          <Text strong style={{ fontSize: '13px' }}>
                            {msg.author.name}
                          </Text>
                          {/* Render reasoning if present */}
                          {msg.reasoning && (
                            <div style={{ marginBottom: '8px' }}>
                              {(() => {
                                const messageKey = `${msg.chatId}-${msg.sequence}`
                                const isExpanded = expandedReasoning.has(messageKey)
                                return (
                                  <div>
                                    <div
                                      onClick={() => toggleReasoningExpansion(messageKey)}
                                      style={{
                                        fontSize: '12px',
                                        color: 'rgba(0, 0, 0, 0.45)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        cursor: 'pointer',
                                      }}
                                    >
                                      <span style={{ fontFamily: 'monospace' }}>{isExpanded ? '▼' : '▶'}</span>
                                      <span style={{ fontWeight: 'bold', fontStyle: 'italic' }}>Reasoning</span>
                                    </div>
                                    {isExpanded && (
                                      <div style={{
                                        marginTop: '4px',
                                        fontSize: '14px',
                                        color: 'rgba(0, 0, 0, 0.65)',
                                        whiteSpace: 'pre-wrap',
                                      }}>
                                        {msg.reasoning}
                                      </div>
                                    )}
                                  </div>
                                )
                              })()}
                            </div>
                          )}
                          <div style={{ fontSize: '14px' }} className={styles.markdownContent}>
                            {msg.capsules && msg.capsules.length > 0
                              ? renderMessageWithCapsules(msg.message, msg.capsules)
                              : (
                                <ReactMarkdown skipHtml={true}>
                                  {msg.message}
                                </ReactMarkdown>
                              )
                            }
                          </div>
                          {/* Render tool calls if present */}
                          {msg.toolCalls && msg.toolCalls.length > 0 && (
                            <div style={{ marginTop: '8px' }}>
                              {msg.toolCalls.map((toolCall, tcIdx) => {
                                const isExpanded = expandedToolCalls.has(toolCall.toolCallId)
                                return (
                                  <div
                                    key={`${msg.chatId}-${msg.sequence}-tool-${tcIdx}`}
                                    style={{
                                      fontSize: '12px',
                                      padding: '8px 12px',
                                      backgroundColor: toolCall.error ? '#fff2f0' : '#f9f9f9',
                                      border: toolCall.error ? '1px solid #ffccc7' : '1px solid #e8e8e8',
                                      borderRadius: '4px',
                                      marginBottom: '4px',
                                      fontFamily: 'monospace',
                                    }}
                                  >
                                    <div
                                      onClick={() => toggleToolCallExpansion(toolCall.toolCallId)}
                                      style={{
                                        color: 'rgba(0, 0, 0, 0.65)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '8px',
                                        cursor: 'pointer',
                                        userSelect: 'none'
                                      }}
                                    >
                                      <span style={{ fontSize: '10px' }}>{isExpanded ? '▼' : '▶'}</span>
                                      <span style={{ fontWeight: 'bold' }}>{toolCall.toolName}</span>
                                      {toolCall.toolName === 'readFile' && (
                                        <span style={{ marginLeft: '4px' }}>
                                          {toolCall.input.filename}
                                        </span>
                                      )}
                                      {toolCall.toolName === 'editFile' && (
                                        <span style={{ marginLeft: '4px' }}>
                                          {toolCall.input.filename}
                                        </span>
                                      )}
                                      {toolCall.error && (
                                        <span style={{ marginLeft: 'auto', color: '#cf1322', fontWeight: 'bold' }}>
                                          ⚠ ERROR
                                        </span>
                                      )}
                                    </div>
                                    {isExpanded && (
                                      <>
                                        {toolCall.error && (
                                          <div style={{
                                            marginTop: '8px',
                                            padding: '8px',
                                            backgroundColor: '#fff1f0',
                                            border: '1px solid #ffa39e',
                                            borderRadius: '2px',
                                            color: '#cf1322',
                                            fontSize: '11px'
                                          }}>
                                            <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>Error:</div>
                                            <div style={{ whiteSpace: 'pre-wrap' }}>{toolCall.error}</div>
                                          </div>
                                        )}
                                        {toolCall.toolName === 'executeCode' ? (
                                          <>
                                            <div style={{
                                              marginTop: '8px',
                                              fontSize: '11px',
                                              color: 'rgba(0, 0, 0, 0.45)',
                                              fontWeight: 'bold'
                                            }}>
                                              Code:
                                            </div>
                                            <pre style={{
                                              marginTop: '4px',
                                              marginBottom: 0,
                                              padding: '8px',
                                              backgroundColor: '#ffffff',
                                              border: '1px solid #e8e8e8',
                                              borderRadius: '2px',
                                              fontSize: '11px',
                                              overflow: 'auto',
                                              maxHeight: '300px'
                                            }}>
                                              {toolCall.input.code}
                                            </pre>
                                            {toolCall.output && (
                                              <>
                                                <div style={{
                                                  marginTop: '8px',
                                                  fontSize: '11px',
                                                  color: 'rgba(0, 0, 0, 0.45)',
                                                  fontWeight: 'bold'
                                                }}>
                                                  Output:
                                                </div>
                                                <pre style={{
                                                  marginTop: '4px',
                                                  marginBottom: 0,
                                                  padding: '8px',
                                                  backgroundColor: '#f5f5f5',
                                                  border: '1px solid #d9d9d9',
                                                  borderRadius: '2px',
                                                  fontSize: '11px',
                                                  overflow: 'auto',
                                                  maxHeight: '300px',
                                                  color: '#262626'
                                                }}>
                                                  {toolCall.output}
                                                </pre>
                                              </>
                                            )}
                                          </>
                                        ) : (
                                          <pre style={{
                                            marginTop: '8px',
                                            marginBottom: 0,
                                            padding: '8px',
                                            backgroundColor: '#ffffff',
                                            border: '1px solid #e8e8e8',
                                            borderRadius: '2px',
                                            fontSize: '11px',
                                            overflow: 'auto',
                                            maxHeight: '300px'
                                          }}>
                                            {JSON.stringify(toolCall.input, null, 2)}
                                          </pre>
                                        )}
                                      </>
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          )}
                          <Text type="secondary" style={{ fontSize: '11px' }}>
                            {msg.timestamp.toLocaleTimeString()}
                          </Text>
                        </Space>
                      </div>
                    ) : msg.type === 'changes' ? (
                      // Changes message
                      (() => {
                        const status = messageStates.changeStatus.get(msg.sequence) || 'pending'
                        return (
                          <div style={{ maxWidth: '800px', margin: '0 auto' }}>
                            <div
                              style={{
                                fontSize: '12px',
                                padding: '8px 12px',
                                backgroundColor: status === 'merged' ? '#f6ffed' : status === 'reverted' ? '#fff7e6' : '#e6f7ff',
                                border: status === 'merged' ? '1px solid #b7eb8f' : status === 'reverted' ? '1px solid #ffd591' : '1px solid #91d5ff',
                                borderRadius: '4px'
                              }}
                            >
                              <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '8px',
                                marginBottom: status === 'pending' ? '8px' : '0'
                              }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                                  <span>📝</span>
                                  <span style={{
                                    fontStyle: 'italic',
                                    color: status === 'merged' ? '#52c41a' : status === 'reverted' ? '#fa8c16' : '#1890ff',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap'
                                  }}>
                                    {msg.author.name} made changes
                                  </span>
                                  {status === 'merged' && (
                                    <span style={{ fontSize: '11px', color: '#52c41a', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                                      ✓ merged
                                    </span>
                                  )}
                                  {status === 'reverted' && (
                                    <span style={{ fontSize: '11px', color: '#fa8c16', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                                      ↩ reverted
                                    </span>
                                  )}
                                </div>
                                <Text type="secondary" style={{ fontSize: '11px', whiteSpace: 'nowrap' }}>
                                  {msg.timestamp.toLocaleTimeString()}
                                </Text>
                              </div>

                              {status === 'pending' && (
                                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                                  <Tooltip title="Merge this change and all previous changes in this chat thread into the Gadget's mainline code.">
                                    <Button
                                      size="small"
                                      type="primary"
                                      disabled={isAgentActive}
                                      onClick={() => handleMergeChanges(msg.sequence)}
                                    >
                                      Merge changes
                                    </Button>
                                  </Tooltip>
                                  <Tooltip title="Undo this change, and all later changes currently proposed in the thread.">
                                    <Button
                                      size="small"
                                      danger
                                      disabled={isAgentActive}
                                      onClick={() => handleRevertChanges(msg.sequence)}
                                    >
                                      Revert from here
                                    </Button>
                                  </Tooltip>
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })()
                    ) : msg.type === 'merge' ? (
                      // Merge action message
                      (() => {
                        const timestamp = messageStates.mergeTimestamps.get(msg.sequence)
                        return (
                          <div style={{ maxWidth: '800px', margin: '0 auto' }}>
                            <div
                              style={{
                                fontSize: '12px',
                                fontStyle: 'italic',
                                opacity: 0.7,
                                color: '#52c41a',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px'
                              }}
                            >
                              <span>✅</span>
                              <span>
                                {msg.author.name} merged all changes through{' '}
                                {timestamp ? timestamp.toLocaleString() : 'unknown time'}
                              </span>
                              <Text type="secondary" style={{ fontSize: '11px', fontStyle: 'normal' }}>
                                {msg.timestamp.toLocaleTimeString()}
                              </Text>
                            </div>
                          </div>
                        )
                      })()
                    ) : msg.type === 'revert' ? (
                      // Revert action message
                      (() => {
                        const timestamp = messageStates.revertTimestamps.get(msg.sequence)
                        return (
                          <div style={{ maxWidth: '800px', margin: '0 auto' }}>
                            <div
                              style={{
                                fontSize: '12px',
                                fontStyle: 'italic',
                                opacity: 0.7,
                                color: '#fa8c16',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px'
                              }}
                            >
                              <span>↩️</span>
                              <span>
                                {msg.author.name} reverted changes from{' '}
                                {timestamp ? timestamp.toLocaleString() : 'unknown time'} onward
                              </span>
                              <Text type="secondary" style={{ fontSize: '11px', fontStyle: 'normal' }}>
                                {msg.timestamp.toLocaleTimeString()}
                              </Text>
                            </div>
                          </div>
                        )
                      })()
                    ) : msg.type === 'action' ? (
                      // Action/observation message
                      (() => {
                        const actionLog = msg.actionLog
                        if (!actionLog) return null

                        const isAction = actionLog.type === 'action'
                        const state = actionLog.state
                        const isExpanded = expandedActions.has(msg.actionId)
                        const isProcessing = processingActions.has(msg.actionId)

                        // Color scheme: observations always neutral, actions colored by state
                        const colors = !isAction
                          ? { bg: '#f5f5f5', border: '#d9d9d9', accent: '#595959' }
                          : state === 'approved'
                          ? { bg: '#f6ffed', border: '#b7eb8f', accent: '#52c41a' }
                          : state === 'rejected'
                          ? { bg: '#fff2f0', border: '#ffccc7', accent: '#cf1322' }
                          : { bg: '#e6f7ff', border: '#91d5ff', accent: '#1890ff' }

                        return (
                          <div style={{ maxWidth: '800px', margin: '0 auto' }}>
                            <div
                              style={{
                                fontSize: '12px',
                                padding: '8px 12px',
                                backgroundColor: colors.bg,
                                border: `1px solid ${colors.border}`,
                                borderRadius: '4px'
                              }}
                            >
                              {/* Header row */}
                              <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '8px',
                              }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
                                  <span
                                    onClick={() => toggleActionExpansion(msg.actionId)}
                                    style={{ fontSize: '10px', cursor: 'pointer', userSelect: 'none', fontFamily: 'monospace' }}
                                  >
                                    {isExpanded ? '▼' : '▶'}
                                  </span>
                                  <span style={{ fontWeight: 'bold', color: colors.accent }}>
                                    {isAction ? 'Action' : 'Observation'}
                                  </span>
                                  <span style={{ color: 'rgba(0, 0, 0, 0.65)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {actionLog.bindingName && <Text code style={{ fontSize: '11px' }}>{actionLog.bindingName}</Text>}
                                    {actionLog.bindingName && ' '}
                                    {actionLog.resourceUrl
                                      ? <Link href={actionLog.resourceUrl} target="_blank" style={{ fontSize: '12px' }}>{actionLog.resourceTitle}</Link>
                                      : actionLog.resourceTitle}
                                  </span>
                                  {isAction && state === 'approved' && (
                                    <span style={{ fontSize: '11px', color: '#52c41a', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                                      ✓ approved{actionLog.appliedAt ? ` ${actionLog.appliedAt.toLocaleTimeString()}` : ''}
                                    </span>
                                  )}
                                  {isAction && state === 'rejected' && (
                                    <span style={{ fontSize: '11px', color: '#cf1322', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                                      ✗ rejected
                                    </span>
                                  )}
                                </div>
                                <Text type="secondary" style={{ fontSize: '11px', whiteSpace: 'nowrap' }}>
                                  {msg.timestamp.toLocaleTimeString()}
                                </Text>
                              </div>

                              {/* Action title */}
                              <div
                                onClick={() => toggleActionExpansion(msg.actionId)}
                                style={{
                                  marginTop: '4px',
                                  paddingLeft: '18px',
                                  cursor: 'pointer',
                                  userSelect: 'none',
                                  color: 'rgba(0, 0, 0, 0.85)',
                                }}
                              >
                                {actionLog.description.title}
                              </div>

                              {/* Expanded description */}
                              {isExpanded && (
                                <div style={{
                                  marginTop: '8px',
                                  paddingLeft: '18px',
                                  whiteSpace: 'pre-wrap',
                                  color: 'rgba(0, 0, 0, 0.65)',
                                  fontSize: '11px',
                                  borderTop: '1px solid ' + colors.border,
                                  paddingTop: '8px',
                                }}>
                                  {actionLog.description.description}
                                </div>
                              )}

                              {/* Approve/reject buttons for pending actions */}
                              {isAction && state === 'pending' && (
                                <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '8px' }}>
                                  <Button
                                    size="small"
                                    type="primary"
                                    onClick={() => handleApproveAction(msg.actionId)}
                                    loading={isProcessing}
                                    disabled={isProcessing}
                                  >
                                    Approve
                                  </Button>
                                  <Button
                                    size="small"
                                    danger
                                    onClick={() => handleRejectAction(msg.actionId)}
                                    loading={isProcessing}
                                    disabled={isProcessing}
                                  >
                                    Reject
                                  </Button>
                                </div>
                              )}
                            </div>
                          </div>
                        )
                      })()
                    ) : msg.type === 'useGadget' ? (
                      <div style={{ maxWidth: '800px', margin: '0 auto' }}>
                        <div
                          style={{
                            fontSize: '12px',
                            padding: '8px 12px',
                            backgroundColor: '#f5f5f5',
                            border: '1px solid #d9d9d9',
                            borderRadius: '4px',
                          }}
                        >
                          <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '8px',
                          }}>
                            <span style={{ color: '#595959' }}>
                              Agent used the Gadget
                            </span>
                            <Text type="secondary" style={{ fontSize: '11px', whiteSpace: 'nowrap' }}>
                              {msg.timestamp.toLocaleTimeString()}
                            </Text>
                          </div>
                        </div>
                      </div>
                    ) : msg.type === 'error' ? (() => {
                      const messageKey = `${msg.chatId}-${msg.sequence}`
                      const isLastMessage = idx === currentMessages.length - 1 && !isAgentActive
                      const isExpanded = isLastMessage || expandedErrors.has(messageKey)
                      return (
                        <div style={{ maxWidth: '800px', margin: '0 auto' }}>
                          <div
                            style={{
                              fontSize: '12px',
                              padding: '8px 12px',
                              backgroundColor: '#fff2f0',
                              border: '1px solid #ffccc7',
                              borderRadius: '4px',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '8px',
                                cursor: isLastMessage ? undefined : 'pointer',
                              }}
                              onClick={isLastMessage ? undefined : () => toggleErrorExpansion(messageKey)}
                            >
                              <span style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px',
                                color: '#cf1322',
                                fontWeight: 'bold',
                              }}>
                                <ExclamationCircleOutlined />
                                {isExpanded ? 'Error' : 'Error (click to expand)'}
                              </span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <Text type="secondary" style={{ fontSize: '11px', whiteSpace: 'nowrap' }}>
                                  {msg.timestamp.toLocaleTimeString()}
                                </Text>
                                {!isLastMessage && (
                                  <span style={{ fontFamily: 'monospace', color: '#cf1322' }}>
                                    {isExpanded ? '▼' : '▶'}
                                  </span>
                                )}
                              </div>
                            </div>
                            {isExpanded && (
                              <>
                                <div style={{
                                  marginTop: '8px',
                                  padding: '8px',
                                  backgroundColor: '#fff1f0',
                                  border: '1px solid #ffa39e',
                                  borderRadius: '2px',
                                  color: '#cf1322',
                                  fontSize: '11px',
                                  fontFamily: 'monospace',
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word',
                                }}>
                                  {msg.message}
                                </div>
                                {isLastMessage && (
                                  <div style={{ marginTop: '8px', display: 'flex', justifyContent: 'flex-end' }}>
                                    <Button
                                      icon={<ReloadOutlined />}
                                      onClick={handleRetry}
                                      size="small"
                                      type="primary"
                                      danger
                                      disabled={selectedModel === null}
                                      title={selectedModel === null ? 'Select a model to retry' : undefined}
                                    >
                                      Retry
                                    </Button>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      )
                    })() : null}
                  </div>
                ))}
                {/* Typing indicator when agent is active */}
                {isAgentActive && activeAgent && (
                  <div
                    style={{
                      width: '100%',
                      padding: '16px 24px',
                    }}
                  >
                    <div style={{ maxWidth: '800px', margin: '0 auto', position: 'relative' }}>
                      <Space direction="vertical" size="small" style={{ width: '100%' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <Text strong style={{ fontSize: '13px' }}>
                            {activeAgent.name}
                          </Text>
                          <Button
                            icon={<StopOutlined />}
                            onClick={handleStop}
                            danger
                            size="small"
                          >
                            Stop
                          </Button>
                        </div>
                        <Space>
                          <Spin size="small" />
                        </Space>
                      </Space>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Bottom area: proposed changes banner, input, token summary — constrained to content width */}
          <div style={{ maxWidth: '800px', margin: '0 auto', width: '100%' }}>
            {/* Accept button for proposed changes */}
            {(() => {
              if (!currentChatMetadata?.hasProposedChanges || isAgentActive) return null

              const { activeChanges } = messageStates
              if (activeChanges.length === 0) return null

              // Find the last change message that's still active
              const lastActiveChange = [...currentMessages]
                .reverse()
                .find(m => m.type === 'changes' && messageStates.changeStatus.get(m.sequence) === 'pending')

              if (!lastActiveChange) return null

              return (
                <div style={{
                  padding: '16px',
                  borderTop: '1px solid #f0f0f0',
                  backgroundColor: '#f0f7ff',
                  display: 'flex',
                  gap: '8px',
                  alignItems: 'center'
                }}>
                  <span style={{ flex: 1, fontSize: '14px', color: '#1890ff' }}>
                    The agent has proposed changes to the code
                  </span>
                  <Tooltip title="Merge all changes proposed in this thread into the Gadget's mainline code.">
                    <Button
                      type="primary"
                      icon={<CheckCircleOutlined />}
                      onClick={() => handleMergeChanges(lastActiveChange.sequence)}
                    >
                      Merge All Changes
                    </Button>
                  </Tooltip>
                </div>
              )
            })()}

            {/* Input area */}
            <ChatInput
              createCapsuleGatekeeper={(accountId, url) => overseer.newGatekeeper(accountId, url)}
              getOverseer={() => overseer}
              onSend={handleSend}
              isAgentActive={isAgentActive}
              models={availableModels}
              selectedModel={selectedModel}
              onModelChange={handleModelChange}
              pendingConsoleLogCount={pendingConsoleLogCount}
              consoleLogPreview={consoleLogPreview}
              consoleLogSeverity={consoleLogSeverity}
              onConsumeConsoleLogs={onConsumeConsoleLogs}
              onDiscardConsoleLogs={onDiscardConsoleLogs}
            />

            {/* Token / cost summary */}
            {(currentChatMetadata?.totalTokens != null || currentChatMetadata?.totalCost != null) && (
              <div style={{
                padding: '0 16px 16px',
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '16px',
                fontSize: '12px',
                color: '#595959',
              }}>
                {currentChatMetadata.totalTokens != null && (
                  <span>{currentChatMetadata.totalTokens.toLocaleString()} tokens</span>
                )}
                {currentChatMetadata.totalCost != null && (
                  <span>${currentChatMetadata.totalCost.toFixed(4)}</span>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default ChatInterface
