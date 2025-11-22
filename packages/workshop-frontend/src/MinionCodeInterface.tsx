import { useState, useEffect, useRef } from 'react'
import { message } from 'antd'
import { Overseer, CodeSubscriber, CodeUpdate } from '@minions/workshop-shared/api'
import { RpcStub, RpcTarget } from 'capnweb'
import * as Y from 'yjs'
import FileSidebar from './FileSidebar'
import CodeEditor from './CodeEditor'

// RpcTarget implementation for receiving code updates from the server
class CodeSubscriberImpl extends RpcTarget implements CodeSubscriber {
  private disabled: boolean = false;

  constructor(
    private ydoc: Y.Doc,
    private onReady: () => void,
    private onVersionUpdate: (version: number) => void
  ) {
    super()
  }

  update(up: CodeUpdate): void {
    if (this.disabled) return;

    // Apply the Yjs update to our local document
    // Mark origin as 'server' so we don't echo it back
    Y.applyUpdateV2(this.ydoc, up.update, 'server')

    // Update version and pass the update to be applied to server shadow doc
    this.onVersionUpdate(up.version)
  }

  ready(): void {
    if (this.disabled) return;

    // Called when we're initially synced with the server
    this.onReady()
  }

  // local call
  disable(): void {
    this.disabled = true;
  }
}

interface MinionCodeInterfaceProps {
  overseer: RpcStub<Overseer>
  height?: string | number
  onCodeChange?: () => void
}

export default function MinionCodeInterface({ overseer, height = '100%', onCodeChange }: MinionCodeInterfaceProps) {
  // Yjs document and files map - persistent across reconnections
  const ydocRef = useRef<Y.Doc>(new Y.Doc())
  const filesMapRef = useRef<Y.Map<Y.Text>>(ydocRef.current.getMap(''))

  // Updates originating locally are enqueued to this array.
  const updateQueueRef = useRef<Uint8Array[]>([]);

  // Track the server's version for reconnection
  const serverVersionRef = useRef<number>(0)

  // Track whether we're currently sending updates to prevent concurrent sends
  const isSendingRef = useRef<boolean>(false)

  // React state for UI
  const [fileNames, setFileNames] = useState<string[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)

  // Keep a ref to the current overseer so operations always use the latest stub
  const currentOverseerRef = useRef(overseer)
  currentOverseerRef.current = overseer

  // Keep a ref to the ready state so we can check it in error handlers without closure issues
  const isReadyRef = useRef(false)

  // Subscription stub for cleanup
  const subscriptionRef = useRef<RpcStub<{}> | null>(null)

  // Set up Y.Map observer to sync file list to React state
  useEffect(() => {
    const filesMap = filesMapRef.current

    const updateFileList = () => {
      const names = Array.from(filesMap.keys()).sort()
      setFileNames(names)

      // Set first file as active if none is selected
      if (!activeFile && names.length > 0) {
        setActiveFile(names[0])
      }
    }

    // Initial sync
    updateFileList()

    // Observe changes to the map
    const observer = (_event: Y.YMapEvent<Y.Text>) => {
      updateFileList()
    }

    filesMap.observe(observer)

    return () => {
      filesMap.unobserve(observer)
    }
  }, []) // Only run once on mount

  // Helper to send updates to server based on what it's missing
  // Uses a loop to ensure all changes get sent, with only one send in flight at a time
  const sendUpdateToServer = async (update?: Uint8Array) => {
    if (update) {
      updateQueueRef.current.push(update);
    }

    // If already sending, return early - the running instance will pick up our changes
    if (isSendingRef.current) {
      return
    }

    isSendingRef.current = true

    try {
      // Loop until there's nothing left to send
      while (updateQueueRef.current.length > 0) {
        // If multiple updates are queued, first merge them into a single update, for efficiency.
        if (updateQueueRef.current.length > 1) {
          let merged = Y.mergeUpdatesV2(updateQueueRef.current);
          updateQueueRef.current = [merged];
        }

        try {
          await currentOverseerRef.current.updateCode(updateQueueRef.current[0])
          // Successfully sent - clear unsaved changes indicator
          setHasUnsavedChanges(false)
        } catch (error) {
          console.error('Failed to send update to server:', error)
          // Mark that we have unsaved changes
          setHasUnsavedChanges(true)
          // On error, stop trying to avoid hammering the server
          break
        }

        // Discard the update we successfully sent.
        updateQueueRef.current.shift();

        // More updates may have been queued in the meantime. Loop to handle them.

        // TODO: Consider putting a small delay here to coalesce more continuous keystrokes?
      }
    } finally {
      isSendingRef.current = false
    }
  }

  // Subscribe to code updates from server
  useEffect(() => {
    const ydoc = ydocRef.current
    const isInitialLoad = serverVersionRef.current === 0

    const subscriberImpl = new CodeSubscriberImpl(
      ydoc,
      () => {
        setIsReady(true)
        isReadyRef.current = true
        setLoading(false)
        // Send any local changes after we're synced with server
        // This handles reconnection after offline edits
        sendUpdateToServer()
      },
      (version: number) => {
        // Update version
        serverVersionRef.current = version
      }
    )

    const subscribe = async () => {
      try {
        // Only show loading state on initial load, not on reconnection
        if (isInitialLoad) {
          setLoading(true)
        }

        // Subscribe from the last known version (0 for initial load)
        const subscriptionStub = await currentOverseerRef.current.subscribeToCode(
          subscriberImpl,
          serverVersionRef.current
        )
        subscriptionRef.current = subscriptionStub

        // If this is a reconnection, the user can continue editing immediately
        if (!isInitialLoad) {
          setIsReady(true)
        }
      } catch (error) {
        console.error('Failed to subscribe to code updates:', error)
        // Only show error if we've never successfully loaded (never reached ready state)
        if (!isReadyRef.current) {
          message.error('Failed to load code files')
          setLoading(false)
        }
        // For reconnection failures after we've loaded, don't show toast - user can keep editing
      }
    }

    subscribe()

    return () => {
      // Cleanup: dispose subscription stub
      if (subscriptionRef.current) {
        subscriptionRef.current[Symbol.dispose]()
        subscriptionRef.current = null
      }
      subscriberImpl.disable();
    }
  }, [overseer])

  // Set up Y.Doc observer to send local changes to server
  useEffect(() => {
    const ydoc = ydocRef.current

    const updateHandler = async (update: Uint8Array, origin: any) => {
      onCodeChange?.()

      // Don't send updates that came from the server back to the server
      if (origin === 'server') {
        return
      }

      // Send update to server
      await sendUpdateToServer(update)
    }

    ydoc.on('updateV2', updateHandler)

    return () => {
      ydoc.off('updateV2', updateHandler)
    }
  }, [overseer, onCodeChange])

  // Handle file selection
  const handleFileSelect = (filename: string) => {
    setActiveFile(filename)
  }

  // Handle file creation
  const handleFileCreate = (filename: string) => {
    const filesMap = filesMapRef.current

    // Check if file already exists
    if (filesMap.has(filename)) {
      message.error(`File already exists: ${filename}`)
      return
    }

    // Create new Y.Text for the file
    filesMap.set(filename, new Y.Text())
    setActiveFile(filename)
    message.success(`Created file: ${filename}`)
  }

  // Handle file deletion
  const handleFileDelete = (filename: string) => {
    const filesMap = filesMapRef.current

    if (!filesMap.has(filename)) {
      message.error('File not found')
      return
    }

    // Delete from Y.Map
    filesMap.delete(filename)

    // Switch to another file if the deleted file was active
    if (activeFile === filename) {
      const remainingFiles = Array.from(filesMap.keys()).sort()
      setActiveFile(remainingFiles.length > 0 ? remainingFiles[0] : null)
    }

    message.success(`Deleted file: ${filename}`)
  }

  // Handle file renaming
  const handleFileRename = (oldName: string, newName: string) => {
    const filesMap = filesMapRef.current

    // Check if old file exists
    const ytext = filesMap.get(oldName)
    if (!ytext) {
      message.error('File not found')
      return
    }

    // Check if new name already exists
    if (filesMap.has(newName)) {
      message.error(`File already exists: ${newName}`)
      return
    }

    // Set new file with the same Y.Text instance
    // We have to clone the Y.Text. We can't reuse the same object in a new location, sadly.
    filesMap.set(newName, ytext.clone())
    // Delete old file
    filesMap.delete(oldName)

    // Update active file if it was the renamed file
    if (activeFile === oldName) {
      setActiveFile(newName)
    }

    message.success(`Renamed file: ${oldName} → ${newName}`)
  }

  // Get the Y.Text for the active file
  const activeFileYText = activeFile ? filesMapRef.current.get(activeFile) || null : null

  if (loading) {
    return (
      <div
        style={{
          height,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          color: '#6c757d'
        }}
      >
        Loading code files...
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height, width: '100%' }}>
      {hasUnsavedChanges && (
        <div
          style={{
            backgroundColor: '#fff7e6',
            borderBottom: '1px solid #ffd666',
            padding: '8px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '14px',
            color: '#d46b08'
          }}
        >
          <span style={{ fontSize: '16px' }}>⚠️</span>
          <span>Connection issue - changes will be saved when connection is restored</span>
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <FileSidebar
          files={fileNames.map(name => ({ name, content: '' }))}
          activeFile={activeFile}
          dirtyFiles={new Set()}
          onFileSelect={handleFileSelect}
          onFileCreate={handleFileCreate}
          onFileDelete={handleFileDelete}
          onFileRename={handleFileRename}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <CodeEditor
            filename={activeFile}
            ytext={activeFileYText}
            isReady={isReady}
            height="100%"
          />
        </div>
      </div>
    </div>
  )
}