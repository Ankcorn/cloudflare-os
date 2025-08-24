import { useRef, useEffect, useState, useCallback } from 'react'
import { Editor } from '@monaco-editor/react'
import { message } from 'antd'
import { CodeFile } from '@minions/workshop-shared/api'

interface CodeEditorProps {
  file: CodeFile | null
  onSave: (filename: string, content: string) => Promise<void>
  height?: string | number
}

export default function CodeEditor({ file, onSave, height = '100%' }: CodeEditorProps) {
  const editorRef = useRef<any>(null)
  const currentFileRef = useRef<CodeFile | null>(null)
  const autoSaveTimeoutRef = useRef<number | null>(null)
  const [content, setContent] = useState('')

  // Update editor content when file changes (but not when same file content updates)
  useEffect(() => {
    const previousFile = currentFileRef.current
    currentFileRef.current = file // Store current file in ref for callbacks to access
    
    // Only reset content if we're switching to a different file or loading for the first time
    if (!previousFile || !file || previousFile.name !== file.name) {
      if (file) {
        setContent(file.content)
      } else {
        setContent('')
      }
    }
  }, [file])

  // Save function that can be called from blur or auto-save
  const saveCurrentFile = async () => {
    const currentFile = currentFileRef.current
    if (!currentFile || !editorRef.current) return

    const currentContent = editorRef.current.getValue()
    if (currentContent !== currentFile.content) {
      try {
        await onSave(currentFile.name, currentContent)
      } catch (error) {
        console.error('Failed to save file:', error)
        message.error(`Failed to save ${currentFile.name}`)
      }
    }
  }

  // Handle editor focus loss - trigger save
  const handleEditorBlur = async () => {
    // Clear any pending auto-save since we're saving now
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current)
      autoSaveTimeoutRef.current = null
    }
    await saveCurrentFile()
  }

  // Handle content changes - set up auto-save timer
  const handleContentChange = () => {
    // Clear existing timeout
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current)
    }

    // Set new timeout for 1 second
    autoSaveTimeoutRef.current = setTimeout(() => {
      saveCurrentFile()
      autoSaveTimeoutRef.current = null
    }, 1000)
  }

  // Handle editor mount
  const handleEditorDidMount = (editor: any, monaco: any) => {
    editorRef.current = editor

    // Add content change listener for auto-save
    editor.onDidChangeModelContent(() => {
      handleContentChange()
    })

    // Add blur event listener for auto-save
    editor.onDidBlurEditorWidget(() => {
      handleEditorBlur()
    })

    // Set up keyboard shortcuts
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handleEditorBlur() // Just trigger the same save logic
    })
  }

  // Clean up auto-save timeout when component unmounts or file changes
  useEffect(() => {
    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current)
        autoSaveTimeoutRef.current = null
      }
    }
  }, [file])

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

  if (!file) {
    return (
      <div
        style={{
          height,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: '#f8f9fa',
          color: '#6c757d'
        }}
      >
        Select a file to start editing
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', height }}>

      <Editor
        height="100%"
        language={getLanguage(file.name)}
        value={content}
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
          readOnly: false,
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