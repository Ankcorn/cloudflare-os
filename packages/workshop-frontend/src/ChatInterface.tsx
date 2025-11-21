import { useState, useEffect, useRef, useCallback } from 'react'
import { Input, Button, List, Typography, Space, Card, Empty, Spin } from 'antd'
import { SendOutlined, StopOutlined, MessageOutlined, ArrowLeftOutlined } from '@ant-design/icons'
import { RpcStub } from 'capnweb'
import {
  Overseer,
  AiChatMetadata,
  AiChatMessage,
  AiChatSubscriber
} from '@minions/workshop-shared/api'

const { TextArea } = Input
const { Text, Title } = Typography

interface ChatInterfaceProps {
  overseer: RpcStub<Overseer>
}

// Client-side cache for chats and messages (survives reconnects)
interface ChatCache {
  chats: Map<number, AiChatMetadata>
  messages: Map<number, AiChatMessage[]>
  lastMessageTimestamp: Date | null
}

export default function ChatInterface({ overseer }: ChatInterfaceProps) {
  // Persistent cache that survives reconnects
  const cacheRef = useRef<ChatCache>({
    chats: new Map(),
    messages: new Map(),
    lastMessageTimestamp: null
  })

  // UI state
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [, setForceUpdate] = useState(0) // Force re-render when cache updates

  // Subscription stub (wrapped in object for useState)
  const subscriptionRef = useRef<RpcStub<{}> | null>(null)

  // Ref for auto-scrolling messages
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Force a re-render when cache is updated
  const forceUpdate = () => setForceUpdate(prev => prev + 1)

  // Get sorted list of chats from cache
  const chatList = Array.from(cacheRef.current.chats.values())
    .sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime())

  // Get messages for selected chat (filter out any undefined slots in sparse array)
  const currentMessages = selectedChatId !== null
    ? (cacheRef.current.messages.get(selectedChatId) || []).filter(msg => msg !== undefined)
    : []

  // Get metadata for selected chat
  const currentChatMetadata = selectedChatId !== null
    ? cacheRef.current.chats.get(selectedChatId)
    : null

  const isAgentActive = currentChatMetadata?.agentActive || false

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [currentMessages])

  // Create stable subscriber implementation using useRef to hold the implementation
  const subscriberRef = useRef<AiChatSubscriber>({
    metadata(chat: AiChatMetadata) {
      cacheRef.current.chats.set(chat.id, chat)
      forceUpdate()
    },

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
  })

  // Subscribe to chat updates
  useEffect(() => {
    let isMounted = true

    const subscribe = async () => {
      try {
        // Subscribe using startAfter if we have a last message timestamp
        const startAfter = cacheRef.current.lastMessageTimestamp || undefined

        // Don't await - subscribeToChat returns a promise that doesn't resolve until disconnect
        // Store the promise itself as the subscription
        const subscription = overseer.subscribeToChat(
          subscriberRef.current,
          startAfter
        )

        subscriptionRef.current = subscription

        if (isMounted) {
          setIsSubscribed(true)

          // After subscribing, load the list of chats
          // This is safe because subscription will catch any new activity
          const chats = await overseer.listChats()
          chats.forEach(chat => {
            cacheRef.current.chats.set(chat.id, chat)
          })

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
    }
  }, [overseer])

  // Load chat history when selecting a chat
  const selectChat = async (chatId: number) => {
    setSelectedChatId(chatId)

    // If we don't have messages for this chat yet, load them
    if (!cacheRef.current.messages.has(chatId)) {
      setIsLoading(true)
      try {
        const history = await overseer.getChatHistory(chatId)

        // Get or initialize messages array for this chat
        let messages = cacheRef.current.messages.get(chatId)
        if (!messages) {
          messages = []
          cacheRef.current.messages.set(chatId, messages)
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
      } finally {
        setIsLoading(false)
      }
    }
  }

  // Handle sending a message
  const handleSend = async () => {
    if (!inputValue.trim()) return

    const message = inputValue.trim()
    setInputValue('')

    try {
      if (selectedChatId === null) {
        // Create a new chat
        const newChatId = await overseer.newChat(message)
        setSelectedChatId(newChatId)
      } else {
        // Send message to existing chat
        await overseer.sendChatMessage(selectedChatId, message)
      }
    } catch (err) {
      console.error('Failed to send message:', err)
      // Restore the input on error
      setInputValue(message)
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

  // Handle going back to chat list
  const handleBack = () => {
    setSelectedChatId(null)
    setInputValue('')
  }

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
                <TextArea
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder="Type your message to start a conversation with your AI minion..."
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
                  onClick={handleSend}
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
                    onClick={() => selectChat(chat.id)}
                    style={{ cursor: 'pointer', padding: '12px' }}
                  >
                    <List.Item.Meta
                      avatar={<MessageOutlined style={{ fontSize: '20px' }} />}
                      title={
                        <Space>
                          <Text strong>{chat.title}</Text>
                          {chat.agentActive && (
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
              <Button icon={<ArrowLeftOutlined />} onClick={handleBack}>
                Back
              </Button>
              <Title level={5} style={{ margin: 0 }}>
                {currentChatMetadata?.title || 'Chat'}
              </Title>
              {isAgentActive && <Spin size="small" />}
            </Space>
            <Button
              icon={<StopOutlined />}
              onClick={handleStop}
              disabled={!isAgentActive}
              danger
            >
              Stop
            </Button>
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
                {currentMessages.map((msg, idx) => (
                  <div
                    key={`${msg.chatId}-${msg.sequence}`}
                    style={{
                      width: '100%',
                      padding: '16px 24px',
                      backgroundColor: msg.type === 'message' && msg.author.type === 'user'
                        ? '#f5f5f5'
                        : 'white'
                    }}
                  >
                    {msg.type === 'message' ? (
                      <div style={{ maxWidth: '800px', margin: '0 auto' }}>
                        <Space direction="vertical" size="small" style={{ width: '100%' }}>
                          <Text strong style={{ fontSize: '13px' }}>
                            {msg.author.name}
                          </Text>
                          <Text style={{ whiteSpace: 'pre-wrap', fontSize: '14px' }}>
                            {msg.message}
                          </Text>
                          <Text type="secondary" style={{ fontSize: '11px' }}>
                            {msg.timestamp.toLocaleTimeString()}
                          </Text>
                        </Space>
                      </div>
                    ) : (
                      // Observation message
                      <div style={{ maxWidth: '800px', margin: '0 auto' }}>
                        <Text
                          type="secondary"
                          style={{
                            fontSize: '12px',
                            fontStyle: 'italic',
                            opacity: 0.6
                          }}
                        >
                          {msg.description}
                        </Text>
                      </div>
                    )}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Input area */}
          <div style={{ padding: '16px', borderTop: '1px solid #f0f0f0' }}>
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
          </div>
        </>
      )}
    </div>
  )
}
