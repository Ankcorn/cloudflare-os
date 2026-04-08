import { useRef, useEffect, useState } from 'react'
import { Editor } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import * as Y from 'yjs'
import { MonacoBinding } from 'y-monaco'

interface CodeEditorProps {
  filename: string | null
  ytext: Y.Text | null
  isReady: boolean
  height?: string | number
}

export default function CodeEditor({ filename, ytext, isReady, height = '100%' }: CodeEditorProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)
  const bindingRef = useRef<MonacoBinding | null>(null)
  const [editorReady, setEditorReady] = useState(false)

  // Set up Monaco binding when editor and ytext are available.
  // When ytext is transiently null (e.g., streaming doc rebuild), the binding
  // is detached but the Monaco editor stays mounted — no blank flash.
  useEffect(() => {
    const ed = editorRef.current
    const monaco = monacoRef.current

    if (!ed || !monaco || !ytext || !editorReady) {
      return
    }

    // Get or create a model for this file
    const model = ed.getModel()
    if (!model) {
      return
    }

    // Create the binding between Y.Text and Monaco
    // The binding will sync the Y.Text content to the Monaco model
    const binding = new MonacoBinding(
      ytext,
      model,
      new Set([ed])
    )
    bindingRef.current = binding

    return () => {
      // Clean up binding when component unmounts or ytext changes
      binding.destroy()
      bindingRef.current = null
    }
  }, [ytext, editorReady])

  // Handle editor mount
  const handleEditorDidMount = (editor: editor.IStandaloneCodeEditor, monaco: typeof import('monaco-editor')) => {
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
      case 'sh':
      case 'bash':
        return 'shell'
      case 'yaml':
      case 'yml':
        return 'yaml'
      case 'toml':
        return 'toml'
      case 'xml':
        return 'xml'
      case 'svg':
        return 'xml'
      case 'sql':
        return 'sql'
      case 'graphql':
      case 'gql':
        return 'graphql'
      case 'c':
        return 'c'
      case 'cpp':
      case 'cc':
      case 'cxx':
      case 'h':
      case 'hpp':
        return 'cpp'
      default:
        return 'plaintext'
    }
  }

  if (!filename) {
    return (
      <div
        className="flex justify-center items-center bg-kumo-base text-kumo-subtle"
        style={{ height }}
      >
        Select a file to start editing
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', height }}>
      <Editor
        height="100%"
        language={getLanguage(filename)}
        defaultValue=""
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
          readOnly: !isReady,
          cursorStyle: 'line',
          autoIndent: 'full',
          formatOnPaste: true,
          formatOnType: true,
          suggest: {
            snippetsPreventQuickSuggestions: false
          },
          tabSize: 2,
          insertSpaces: true,
          folding: true,
          foldingStrategy: 'indentation',
          showFoldingControls: 'mouseover',
          unfoldOnClickAfterEndOfLine: false,
          contextmenu: true,
          mouseWheelZoom: true
        }}
      />
    </div>
  )
}
