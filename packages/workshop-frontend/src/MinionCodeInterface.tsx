import { useState, useEffect, useRef } from 'react'
import { message } from 'antd'
import { Overseer, CodeSubscriber, CodeUpdate } from '@minions/workshop-shared/api'
import { RpcStub, RpcTarget } from 'capnweb'
import * as Y from 'yjs'
import FileSidebar from './FileSidebar'
import CodeEditor from './CodeEditor'
import CodeDiffEditor from './CodeDiffEditor'

// RpcTarget implementation for receiving code updates from the server
class CodeSubscriberImpl extends RpcTarget implements CodeSubscriber {
  private disabled: boolean = false;

  constructor(
    private ydoc: Y.Doc,
    private modifiedYdocRef: React.MutableRefObject<Y.Doc | null>,
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

    // Also apply to the modified doc if it exists (diff mode)
    // This ensures concurrent changes are reflected in both views
    if (this.modifiedYdocRef.current) {
      Y.applyUpdateV2(this.modifiedYdocRef.current, up.update, 'server')
    }

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
  proposedChanges?: Uint8Array
  fileToSelect?: string
}

export default function MinionCodeInterface({ overseer, height = '100%', onCodeChange, proposedChanges, fileToSelect }: MinionCodeInterfaceProps) {
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

  // Diff mode state - modified Yjs document with proposed changes applied
  const modifiedYdocRef = useRef<Y.Doc | null>(null)
  const modifiedFilesMapRef = useRef<Y.Map<Y.Text> | null>(null)
  const [changedFiles, setChangedFiles] = useState<Set<string>>(new Set())

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

  // Select file when requested from outside
  useEffect(() => {
    if (fileToSelect && filesMapRef.current.has(fileToSelect)) {
      setActiveFile(fileToSelect)
    }
  }, [fileToSelect])

  // Build modified Yjs document when proposedChanges is present
  useEffect(() => {
    if (!proposedChanges) {
      // No proposed changes - clear diff mode
      modifiedYdocRef.current = null
      modifiedFilesMapRef.current = null
      setChangedFiles(new Set())
      return
    }

    // Create a new Y.Doc and apply current state + proposed changes
    const modifiedDoc = new Y.Doc()

    // First, encode the current state
    const currentState = Y.encodeStateAsUpdateV2(ydocRef.current)

    // Apply current state to the modified doc
    Y.applyUpdateV2(modifiedDoc, currentState)

    // Apply the proposed changes
    Y.applyUpdateV2(modifiedDoc, proposedChanges)

    modifiedYdocRef.current = modifiedDoc
    modifiedFilesMapRef.current = modifiedDoc.getMap<Y.Text>('')

    // Compute which files have changed
    const originalMap = filesMapRef.current
    const modifiedMap = modifiedFilesMapRef.current
    const changed = new Set<string>()

    // Check all files in both original and modified
    const allFiles = new Set([
      ...Array.from(originalMap.keys()),
      ...Array.from(modifiedMap.keys())
    ])

    for (const filename of allFiles) {
      const originalText = originalMap.get(filename)?.toString() || ''
      const modifiedText = modifiedMap.get(filename)?.toString() || ''

      if (originalText !== modifiedText) {
        changed.add(filename)
      }
    }

    setChangedFiles(changed)
  }, [proposedChanges])

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
      modifiedYdocRef,
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

  // Get the Y.Text for the active file (original version)
  const activeFileYText = activeFile ? filesMapRef.current.get(activeFile) || null : null

  // Get the modified Y.Text when in diff mode
  const activeFileModifiedYText = activeFile && modifiedFilesMapRef.current
    ? modifiedFilesMapRef.current.get(activeFile) || null
    : null

  // Determine if we're in diff mode
  const isDiffMode = proposedChanges !== undefined && modifiedYdocRef.current !== null

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
          files={fileNames}
          activeFile={activeFile}
          dirtyFiles={new Set()}
          changedFiles={changedFiles}
          isDiffMode={isDiffMode}
          onFileSelect={handleFileSelect}
          onFileCreate={handleFileCreate}
          onFileDelete={handleFileDelete}
          onFileRename={handleFileRename}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          {isDiffMode ? (
            <CodeDiffEditor
              filename={activeFile}
              originalYText={activeFileYText}
              modifiedYText={activeFileModifiedYText}
              height="100%"
            />
          ) : (
            <CodeEditor
              filename={activeFile}
              ytext={activeFileYText}
              isReady={isReady}
              height="100%"
            />
          )}
        </div>
      </div>
    </div>
  )
}