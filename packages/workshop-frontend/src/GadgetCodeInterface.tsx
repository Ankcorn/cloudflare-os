import { useState, useEffect, useRef, useCallback } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { Overseer, CodeSubscriber, CodeUpdate } from '@gadgets/workshop-shared/api'
import { RpcStub, RpcTarget } from 'capnweb'
import * as Y from 'yjs'
import FileSidebar from './FileSidebar'
import CodeEditor from './CodeEditor'
import CodeDiffEditor from './CodeDiffEditor'
import type { StreamingProposedChanges } from './ChatInterface'

// RpcTarget implementation for receiving code updates from the server
class CodeSubscriberImpl extends RpcTarget implements CodeSubscriber {
  private disabled: boolean = false;

  constructor(
    private ydoc: Y.Doc,
    private modifiedYdocRef: React.MutableRefObject<Y.Doc | null>,
    private streamingYdocRef: React.MutableRefObject<Y.Doc | null>,
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

    if (this.streamingYdocRef.current) {
      Y.applyUpdateV2(this.streamingYdocRef.current, up.update, 'server')
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

interface GadgetCodeInterfaceProps {
  overseer: RpcStub<Overseer>
  height?: string | number
  onCodeChange?: () => void
  proposedChanges?: Uint8Array
  streamingProposedChanges?: StreamingProposedChanges
  fileToSelect?: string
  onHasCodeChange?: (hasCode: boolean) => void
}

function didFileChange(originalMap: Y.Map<Y.Text>, previewMap: Y.Map<Y.Text>, filename: string) {
  const originalText = originalMap.get(filename)?.toString() || ''
  const previewText = previewMap.get(filename)?.toString() || ''
  return originalText !== previewText
}

function computeChangedFiles(originalMap: Y.Map<Y.Text>, previewMap: Y.Map<Y.Text>) {
  const changed = new Set<string>()
  const allFiles = new Set([
    ...Array.from(originalMap.keys()),
    ...Array.from(previewMap.keys()),
  ])

  for (const filename of allFiles) {
    if (didFileChange(originalMap, previewMap, filename)) {
      changed.add(filename)
    }
  }

  return changed
}

function areSetsEqual(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

function getTouchedFilesFromEvents(events: Y.YEvent<any>[], rootMap: Y.Map<Y.Text>) {
  const filenames = new Set<string>()

  for (const event of events) {
    if (event.target === rootMap && 'keysChanged' in event) {
      for (const key of (event as Y.YMapEvent<Y.Text>).keysChanged) {
        if (typeof key === 'string') {
          filenames.add(key)
        }
      }
      continue
    }

    const filename = event.path[0]
    if (typeof filename === 'string') {
      filenames.add(filename)
    }
  }

  return filenames
}

export default function GadgetCodeInterface({ overseer, height = '100%', onCodeChange, proposedChanges, streamingProposedChanges, fileToSelect, onHasCodeChange }: GadgetCodeInterfaceProps) {
  const toasts = useKumoToastManager()

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
  const streamingYdocRef = useRef<Y.Doc | null>(null)
  const streamingFilesMapRef = useRef<Y.Map<Y.Text> | null>(null)
  const previewObserverCleanupRef = useRef<(() => void) | null>(null)
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

  // Auto-select first file when files appear and nothing is selected.
  // In diff mode, files may only exist in the modified document (proposed changes),
  // so we check the full displayed file list, not just fileNames.
  // changedFiles is included as a dependency because its update signals that
  // modifiedFilesMapRef.current has been populated.
  useEffect(() => {
    if (activeFile !== null) return

    const previewMap = streamingFilesMapRef.current ?? modifiedFilesMapRef.current
    const displayed = previewMap
      ? Array.from(new Set([...fileNames, ...Array.from(previewMap.keys())])).sort()
      : fileNames

    if (displayed.length > 0) {
      setActiveFile(displayed[0])
    }
  }, [fileNames, activeFile, changedFiles])

  // Notify parent when code file existence is known. We avoid reporting the
  // initial empty state before the first code subscription has reached ready,
  // which would otherwise make the editor briefly think every gadget has no code.
  const onHasCodeChangeRef = useRef(onHasCodeChange)
  onHasCodeChangeRef.current = onHasCodeChange
  useEffect(() => {
    if (isReady) {
      onHasCodeChangeRef.current?.(fileNames.length > 0)
    }
  }, [isReady, fileNames.length])

  // Select file when requested from outside
  useEffect(() => {
    const previewMap = streamingFilesMapRef.current ?? modifiedFilesMapRef.current
    if (fileToSelect && (filesMapRef.current.has(fileToSelect) || previewMap?.has(fileToSelect))) {
      setActiveFile(fileToSelect)
    }
  }, [fileToSelect, proposedChanges, streamingProposedChanges?.count, streamingProposedChanges?.updates])

  const replaceChangedFiles = useCallback((previewMap: Y.Map<Y.Text> | null) => {
    setChangedFiles(prev => {
      const next = previewMap ? computeChangedFiles(filesMapRef.current, previewMap) : new Set<string>()
      return areSetsEqual(prev, next) ? prev : next
    })
  }, [])

  const updateChangedFilesForNames = useCallback((previewMap: Y.Map<Y.Text> | null, filenames: Iterable<string>) => {
    setChangedFiles(prev => {
      if (!previewMap) {
        return prev.size === 0 ? prev : new Set<string>()
      }

      let next = prev
      for (const filename of filenames) {
        const changed = didFileChange(filesMapRef.current, previewMap, filename)
        const alreadyChanged = next.has(filename)
        if (changed === alreadyChanged) continue

        if (next === prev) {
          next = new Set(prev)
        }

        if (changed) {
          next.add(filename)
        } else {
          next.delete(filename)
        }
      }

      return next
    })
  }, [])

  const observePreviewMap = useCallback((previewMap: Y.Map<Y.Text> | null) => {
    previewObserverCleanupRef.current?.()
    previewObserverCleanupRef.current = null

    if (!previewMap) {
      return
    }

    const observer = (events: Y.YEvent<any>[]) => {
      const touchedFiles = getTouchedFilesFromEvents(events, previewMap)
      if (touchedFiles.size > 0) {
        updateChangedFilesForNames(previewMap, touchedFiles)
      }
    }

    previewMap.observeDeep(observer)
    previewObserverCleanupRef.current = () => {
      previewMap.unobserveDeep(observer)
    }
  }, [updateChangedFilesForNames])

  useEffect(() => {
    return () => {
      previewObserverCleanupRef.current?.()
      previewObserverCleanupRef.current = null
    }
  }, [])

  useEffect(() => {
    const originalMap = filesMapRef.current
    const observer = (events: Y.YEvent<any>[]) => {
      const previewMap = streamingFilesMapRef.current ?? modifiedFilesMapRef.current
      if (!previewMap) {
        return
      }

      const touchedFiles = getTouchedFilesFromEvents(events, originalMap)
      if (touchedFiles.size > 0) {
        updateChangedFilesForNames(previewMap, touchedFiles)
      }
    }

    originalMap.observeDeep(observer)
    return () => {
      originalMap.unobserveDeep(observer)
    }
  }, [updateChangedFilesForNames])

  // Build modified Yjs document when durable proposed changes are present
  useEffect(() => {
    if (!proposedChanges) {
      // No proposed changes - clear diff mode
      modifiedYdocRef.current = null
      modifiedFilesMapRef.current = null
      if (!streamingYdocRef.current) {
        observePreviewMap(null)
        replaceChangedFiles(null)
      }
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
    if (!streamingYdocRef.current) {
      observePreviewMap(modifiedFilesMapRef.current)
      replaceChangedFiles(modifiedFilesMapRef.current)
    }

  }, [observePreviewMap, proposedChanges, replaceChangedFiles])

  // Incrementally apply streaming updates to a persistent streaming Y.Doc.
  // Only new updates (beyond the cursor) are applied each frame.
  const streamingCursorRef = useRef(0)
  const streamingBaseProposedRef = useRef<Uint8Array | undefined>(undefined)
  const streamingUpdatesRef = useRef<Uint8Array[] | undefined>(undefined)
  // Track the initial set of files when streaming starts, and allow one
  // auto-switch when a genuinely new file (with content) appears.
  const streamingInitialFilesRef = useRef<Set<string> | null>(null)
  const hasAutoSwitchedFileRef = useRef(false)

  useEffect(() => {
    const streamingUpdates = streamingProposedChanges?.updates
    const streamingUpdateCount = streamingProposedChanges?.count ?? 0

    if (!streamingUpdates || streamingUpdateCount === 0) {
      streamingYdocRef.current = null
      streamingFilesMapRef.current = null
      streamingCursorRef.current = 0
      streamingBaseProposedRef.current = undefined
      streamingUpdatesRef.current = undefined
      streamingInitialFilesRef.current = null
      hasAutoSwitchedFileRef.current = false
      observePreviewMap(modifiedFilesMapRef.current)
      replaceChangedFiles(modifiedFilesMapRef.current)
      return
    }

    let rebuiltStreamingDoc = false

    // Rebuild streaming doc if not yet initialized, if the durable base changed,
    // or if the stream history was replaced (chat switch or codeReset).
    if (!streamingYdocRef.current
        || streamingBaseProposedRef.current !== proposedChanges
        || streamingUpdatesRef.current !== streamingUpdates
        || streamingCursorRef.current > streamingUpdateCount) {
      const streamingDoc = new Y.Doc()
      const baseState = modifiedYdocRef.current
        ? Y.encodeStateAsUpdateV2(modifiedYdocRef.current)
        : Y.encodeStateAsUpdateV2(ydocRef.current)
      Y.applyUpdateV2(streamingDoc, baseState)
      streamingYdocRef.current = streamingDoc
      streamingFilesMapRef.current = streamingDoc.getMap<Y.Text>('')
      streamingBaseProposedRef.current = proposedChanges
      streamingUpdatesRef.current = streamingUpdates
      streamingCursorRef.current = 0
      rebuiltStreamingDoc = true
    }

    // Apply only the new incremental updates.
    for (let i = streamingCursorRef.current; i < streamingUpdateCount; i++) {
      Y.applyUpdateV2(streamingYdocRef.current!, streamingUpdates[i])
    }
    streamingCursorRef.current = streamingUpdateCount
    if (rebuiltStreamingDoc) {
      observePreviewMap(streamingFilesMapRef.current)
      replaceChangedFiles(streamingFilesMapRef.current)
      // Capture the initial set of files so we can detect new ones later.
      streamingInitialFilesRef.current = new Set(streamingFilesMapRef.current!.keys())
      hasAutoSwitchedFileRef.current = false
    } else if (streamingFilesMapRef.current && streamingInitialFilesRef.current && !hasAutoSwitchedFileRef.current) {
      // One-shot: auto-select the first genuinely new file with content.
      for (const key of streamingFilesMapRef.current.keys()) {
        if (!streamingInitialFilesRef.current.has(key)) {
          const text = streamingFilesMapRef.current.get(key)
          if (text && text.toString().length > 0) {
            hasAutoSwitchedFileRef.current = true
            setActiveFile(key)
            break
          }
        }
      }
    }
  }, [observePreviewMap, proposedChanges, replaceChangedFiles, streamingProposedChanges?.count, streamingProposedChanges?.updates])

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
      streamingYdocRef,
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
          toasts.add({ title: 'Failed to load code files', variant: 'error' })
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
      toasts.add({ title: `File already exists: ${filename}`, variant: 'error' })
      return
    }

    // Create new Y.Text for the file
    filesMap.set(filename, new Y.Text())
    setActiveFile(filename)
    toasts.add({ title: `Created file: ${filename}`, variant: 'success' })
  }

  // Handle file deletion
  const handleFileDelete = (filename: string) => {
    const filesMap = filesMapRef.current

    if (!filesMap.has(filename)) {
      toasts.add({ title: 'File not found', variant: 'error' })
      return
    }

    // Delete from Y.Map
    filesMap.delete(filename)

    // Switch to another file if the deleted file was active
    if (activeFile === filename) {
      const remainingFiles = Array.from(filesMap.keys()).sort()
      setActiveFile(remainingFiles.length > 0 ? remainingFiles[0] : null)
    }

    toasts.add({ title: `Deleted file: ${filename}`, variant: 'success' })
  }

  // Handle file renaming
  const handleFileRename = (oldName: string, newName: string) => {
    const filesMap = filesMapRef.current

    // Check if old file exists
    const ytext = filesMap.get(oldName)
    if (!ytext) {
      toasts.add({ title: 'File not found', variant: 'error' })
      return
    }

    // Check if new name already exists
    if (filesMap.has(newName)) {
      toasts.add({ title: `File already exists: ${newName}`, variant: 'error' })
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

    toasts.add({ title: `Renamed file: ${oldName} \u2192 ${newName}`, variant: 'success' })
  }

  // Get the Y.Text for the active file (original version)
  const activeFileYText = activeFile ? filesMapRef.current.get(activeFile) || null : null

  // Get the modified Y.Text when in diff mode
  const previewFilesMap = streamingFilesMapRef.current ?? modifiedFilesMapRef.current
  const activeFileModifiedYText = activeFile && previewFilesMap
    ? previewFilesMap.get(activeFile) || null
    : null

  // Determine if we're in diff mode
  const isDiffMode = (streamingProposedChanges !== undefined && streamingYdocRef.current !== null)
    || (proposedChanges !== undefined && modifiedYdocRef.current !== null)

  if (loading) {
    return (
      <div
        className="flex justify-center items-center text-kumo-subtle"
        style={{ height }}
      >
        Loading code files...
      </div>
    )
  }

  // In diff mode, include files from both original and modified documents
  const displayedFiles = isDiffMode && previewFilesMap
    ? Array.from(new Set([...fileNames, ...Array.from(previewFilesMap.keys())])).sort()
    : fileNames

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height, width: '100%' }}>
      {hasUnsavedChanges && (
        <div className="bg-kumo-tint border-b border-kumo-line px-4 py-2 flex items-center gap-2 text-sm text-kumo-warning">
          <span className="text-base">&#9888;&#65039;</span>
          <span>Connection issue - changes will be saved when connection is restored</span>
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <FileSidebar
          files={displayedFiles}
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
          {isDiffMode && activeFileYText != null ? (
            <CodeDiffEditor
              filename={activeFile}
              originalYText={activeFileYText}
              modifiedYText={activeFileModifiedYText}
              height="100%"
            />
          ) : (
            <CodeEditor
              filename={activeFile}
              ytext={isDiffMode ? activeFileModifiedYText : activeFileYText}
              isReady={isReady}
              height="100%"
            />
          )}
        </div>
      </div>
    </div>
  )
}
