import { useState, useEffect, useRef, useMemo } from 'react'
import { Input, Button, List, Typography, Space, Card, Empty, Spin, message, Modal, Select } from 'antd'
import { SendOutlined, StopOutlined, MessageOutlined, EditOutlined, CheckOutlined, CloseOutlined, DeleteOutlined, CheckCircleOutlined } from '@ant-design/icons'
import { RpcStub, RpcTarget } from 'capnweb'
import ReactMarkdown from 'react-markdown'
import * as Y from 'yjs'
import styles from './ChatInterface.module.css'
import {
  Overseer,
  AiChatMetadata,
  AiChatMessage,
  AiChatSubscriber,
  AiChatAuthorInfo
} from '@gadgets/workshop-shared/api'

const { TextArea } = Input
const { Text, Title } = Typography

// Chat input component with internal state to prevent parent re-renders while typing
const ChatInput = ({ onSend, isAgentActive, models, selectedModel, onModelChange }: {
  onSend: (message: string, modelId: string | null) => void
  isAgentActive: boolean
  models: AiChatAuthorInfo[]
  selectedModel: string | null
  onModelChange: (modelId: string | null) => void
}) => {
  const [inputValue, setInputValue] = useState('')

  const handleSend = () => {
    if (!inputValue.trim()) return
    onSend(inputValue.trim(), selectedModel)
    setInputValue('')
  }

  return (
    <div style={{ padding: '16px', borderTop: '1px solid #f0f0f0' }}>
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
        </div>
        <Space.Compact style={{ width: '100%' }}>
          <TextArea
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={
              isAgentActive
                ? 'Waiting for agent to finish...'
                : 'Type your message...'
            }
            autoSize={{ minRows: 1, maxRows: 4 }}
            onPressEnter={(e) => {
              if (e.shiftKey) return
              e.preventDefault()
              if (!isAgentActive) handleSend()
            }}
            style={{ flex: 1 }}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            onClick={handleSend}
            disabled={!inputValue.trim() || isAgentActive}
          >
            Send
          </Button>
        </Space.Compact>
      </Space>
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
}

// Client-side cache for chats and messages (survives reconnects)
interface ChatCache {
  chats: Map<number, AiChatMetadata>
  messages: Map<number, AiChatMessage[]>
  lastMessageTimestamp: Date | null
}

function ChatInterface({ overseer, selectedChatId, onNavigateToChat, onProposedChangesChange, onFileEdited }: ChatInterfaceProps) {
  // Persistent cache that survives reconnects
  const cacheRef = useRef<ChatCache>({
    chats: new Map(),
    messages: new Map(),
    lastMessageTimestamp: null
  })

  // UI state
  const [inputValue, setInputValue] = useState('')
  const [_isSubscribed, setIsSubscribed] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [updateCounter, setUpdateCounter] = useState(0) // Force re-render when cache updates
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleInput, setTitleInput] = useState('')
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(new Set())
  const [expandedReasoning, setExpandedReasoning] = useState<Set<string>>(new Set())
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

  // Notify parent when proposed changes change for the selected chat
  // Compute active (unmerged/unreverted) changes and send to parent
  useEffect(() => {
    if (!currentChatMetadata?.hasProposedChanges) {
      onProposedChangesChange?.(undefined)
      return
    }

    const { activeChanges } = computeMessageStates(currentMessages)

    if (activeChanges.length === 0) {
      onProposedChangesChange?.(undefined)
      return
    }

    const mergedUpdate = activeChanges.length === 1
      ? activeChanges[0]
      : Y.mergeUpdatesV2(activeChanges)

    onProposedChangesChange?.(mergedUpdate)
  }, [currentChatMetadata?.hasProposedChanges, currentMessages, onProposedChangesChange])

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
    processedToolCallsRef.current = new Set()
    setInputValue('')
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

  // Handle sending a message
  const handleSend = async (messageText?: string, modelId?: string | null) => {
    // If messageText is provided (from ChatInput), use it; otherwise use inputValue (from new chat form)
    const message = messageText?.trim() || inputValue.trim()
    if (!message) return

    // Use provided modelId or fall back to selectedModel
    const model = modelId !== undefined ? modelId : selectedModel

    // Only clear inputValue if we're using it (new chat form)
    if (!messageText) {
      setInputValue('')
    }

    try {
      if (selectedChatId === null) {
        // Create a new chat
        const newChatId = await overseer.newChat(message, model)
        onNavigateToChatRef.current(newChatId)
      } else {
        // Send message to existing chat
        await overseer.sendChatMessage(selectedChatId, message, model)
      }
    } catch (err) {
      console.error('Failed to send message:', err)
      // Restore the input on error (only for new chat form)
      if (!messageText) {
        setInputValue(message)
      }
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
              <Space direction="vertical" size="large" style={{ width: '100%' }}>
                <Title level={4} style={{ margin: 0, textAlign: 'center' }}>
                  Start a New Chat
                </Title>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Text type="secondary" style={{ fontSize: '12px' }}>Model:</Text>
                  <Select
                    value={selectedModel}
                    onChange={handleModelChange}
                    style={{ flex: 1 }}
                    options={[
                      { label: '(none)', value: null },
                      ...availableModels.map(model => ({ label: model.name, value: model.id }))
                    ]}
                  />
                </div>
                <TextArea
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder="Type your message to start a conversation with your AI gadget..."
                  autoSize={{ minRows: 3, maxRows: 8 }}
                  onPressEnter={(e) => {
                    if (e.shiftKey) return
                    e.preventDefault()
                    handleSend()
                  }}
                />
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  onClick={() => handleSend()}
                  disabled={!inputValue.trim()}
                  block
                  size="large"
                >
                  Start Chat
                </Button>
              </Space>
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
                    style={{ cursor: 'pointer', padding: '12px' }}
                  >
                    <List.Item.Meta
                      avatar={<MessageOutlined style={{ fontSize: '20px' }} />}
                      title={
                        <Space>
                          <Text strong>{chat.title}</Text>
                          {chat.activeAgent && (
                            <Spin size="small" />
                          )}
                        </Space>
                      }
                      description={
                        <Text type="secondary">
                          Last active: {chat.lastActive.toLocaleString()}
                        </Text>
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
          {/* Chat header */}
          <div style={{
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
          </div>

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
                {currentMessages.map((msg, _idx) => (
                  <div
                    key={`${msg.chatId}-${msg.sequence}`}
                    style={{
                      width: '100%',
                      padding: '16px 24px',
                      backgroundColor: msg.type === 'message' && msg.author.type === 'user'
                        ? '#f5f5f5'
                        : 'white',
                      borderBottom: '1px solid #e8e8e8'
                    }}
                  >
                    {msg.type === 'message' ? (
                      <div style={{ maxWidth: '800px', margin: '0 auto' }}>
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
                            <ReactMarkdown skipHtml={true}>
                              {msg.message}
                            </ReactMarkdown>
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
                                  <Button
                                    size="small"
                                    type="primary"
                                    disabled={isAgentActive}
                                    onClick={() => handleMergeChanges(msg.sequence)}
                                  >
                                    Accept through here
                                  </Button>
                                  <Button
                                    size="small"
                                    danger
                                    disabled={isAgentActive}
                                    onClick={() => handleRevertChanges(msg.sequence)}
                                  >
                                    Revert from here
                                  </Button>
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
                    ) : null}
                  </div>
                ))}
                {/* Typing indicator when agent is active */}
                {isAgentActive && activeAgent && (
                  <div
                    style={{
                      width: '100%',
                      padding: '16px 24px',
                      backgroundColor: 'white',
                      borderBottom: '1px solid #e8e8e8'
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
                <Button
                  type="primary"
                  icon={<CheckCircleOutlined />}
                  onClick={() => handleMergeChanges(lastActiveChange.sequence)}
                >
                  Accept All Changes
                </Button>
              </div>
            )
          })()}

          {/* Input area */}
          <ChatInput
            onSend={handleSend}
            isAgentActive={isAgentActive}
            models={availableModels}
            selectedModel={selectedModel}
            onModelChange={handleModelChange}
          />
        </>
      )}
    </div>
  )
}

export default ChatInterface
