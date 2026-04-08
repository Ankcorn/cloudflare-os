import { useRef, useEffect, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import * as Y from 'yjs'
import { MonacoBinding } from 'y-monaco'

interface CodeDiffEditorProps {
  filename: string | null
  originalYText: Y.Text | null
  modifiedYText: Y.Text | null
  height?: string | number
}

export default function CodeDiffEditor({
  filename,
  originalYText,
  modifiedYText,
  height = '100%'
}: CodeDiffEditorProps) {
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null)
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)
  const originalBindingRef = useRef<MonacoBinding | null>(null)
  const modifiedBindingRef = useRef<MonacoBinding | null>(null)
  const [editorReady, setEditorReady] = useState(false)
  const [renderSideBySide, setRenderSideBySide] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  // Detect container width to switch between side-by-side and inline
  useEffect(() => {
    if (!containerRef.current) return

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const width = entry.contentRect.width
        // Switch to inline mode if width is less than 1200px
        setRenderSideBySide(width >= 1200)
      }
    })

    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
    }
  }, [])

  // Update diff editor options when layout changes
  useEffect(() => {
    if (!editorRef.current) return

    editorRef.current.updateOptions({
      renderSideBySide
    })
  }, [renderSideBySide])

  // Set up Monaco bindings when editor and ytexts are available
  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current

    // modifiedYText is required, but originalYText can be null (for new files)
    if (!editor || !monaco || !modifiedYText || !editorReady) {
      return
    }

    const originalModel = editor.getOriginalEditor().getModel()
    const modifiedModel = editor.getModifiedEditor().getModel()

    if (!originalModel || !modifiedModel) {
      return
    }

    // For new files, originalYText is null - set original to empty string
    if (originalYText) {
      const originalBinding = new MonacoBinding(
        originalYText,
        originalModel,
        new Set([editor.getOriginalEditor()])
      )
      originalBindingRef.current = originalBinding
    } else {
      // New file: original doesn't exist, show empty
      originalModel.setValue('')
    }

    const modifiedBinding = new MonacoBinding(
      modifiedYText,
      modifiedModel,
      new Set([editor.getModifiedEditor()])
    )
    modifiedBindingRef.current = modifiedBinding

    return () => {
      if (originalBindingRef.current) {
        originalBindingRef.current.destroy()
        originalBindingRef.current = null
      }
      modifiedBinding.destroy()
      modifiedBindingRef.current = null
    }
  }, [originalYText, modifiedYText, editorReady])

  // Handle editor mount
  const handleEditorDidMount = (
    editor: editor.IStandaloneDiffEditor,
    monaco: typeof import('monaco-editor')
  ) => {
    editorRef.current = editor
    monacoRef.current = monaco
    setEditorReady(true)
  }

  // Get language from file extension
  const getLanguage = (filename: string): string => {
    const extension = filename.split('.').pop()?.toLowerCase()
    switch (extension) {
      case 'ts':
      case 'tsx':
        return 'typescript'
      case 'js':
      case 'jsx':
        return 'javascript'
      case 'json':
        return 'json'
      case 'html':
        return 'html'
      case 'css':
        return 'css'
      case 'md':
        return 'markdown'
      case 'py':
        return 'python'
      case 'rs':
        return 'rust'
      case 'go':
        return 'go'
      case 'java':
        return 'java'
      case 'c':
      case 'h':
        return 'c'
      case 'cpp':
      case 'cxx':
      case 'cc':
      case 'hpp':
        return 'cpp'
      default:
        return 'plaintext'
    }
  }

  // modifiedYText is required; originalYText can be null for new files
  if (!filename || !modifiedYText) {
    return (
      <div
        className="flex justify-center items-center bg-kumo-base text-kumo-subtle"
        style={{ height }}
      >
        {!filename ? 'Select a file to view changes' : 'Loading diff...'}
      </div>
    )
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', height }}>
      <DiffEditor
        height="100%"
        language={getLanguage(filename)}
        original=""
        modified=""
        keepCurrentOriginalModel={true}
        keepCurrentModifiedModel={true}
        onMount={handleEditorDidMount}
        theme="vs"
        options={{
          automaticLayout: true,
          fontSize: 14,
          lineHeight: 22,
          fontFamily: "'JetBrains Mono', 'SF Mono', Monaco, Inconsolata, 'Roboto Mono', consolas, 'Courier New', monospace",
          minimap: { enabled: true },
          wordWrap: 'on',
          scrollBeyondLastLine: false,
          renderLineHighlight: 'all',
          selectOnLineNumbers: true,
          roundedSelection: false,
          readOnly: true,
          cursorStyle: 'line',
          renderSideBySide,
          contextmenu: true,
          mouseWheelZoom: true,
          // Diff-specific options
          enableSplitViewResizing: true,
          renderOverviewRuler: true,
          diffWordWrap: 'on'
        }}
      />
    </div>
  )
}
