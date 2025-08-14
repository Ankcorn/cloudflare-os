import { useState, useEffect, useCallback } from 'react'
import { message } from 'antd'
import { CodeFile, Overseer } from '@minions/workshop-shared/api'
import { RpcStub } from '@cloudflare/jsrpc'
import FileSidebar from './FileSidebar'
import CodeEditor from './CodeEditor'

interface MinionCodeInterfaceProps {
  overseer: RpcStub<Overseer>
  height?: string | number
  onCodeChange?: () => void
}

export default function MinionCodeInterface({ overseer, height = '100%', onCodeChange }: MinionCodeInterfaceProps) {
  const [files, setFiles] = useState<CodeFile[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Load files from the server - only called once on mount
  useEffect(() => {
    const loadFiles = async () => {
      try {
        setLoading(true)
        const codeFiles = await overseer.getCode()
        setFiles(codeFiles)
        
        // Set first file as active
        if (codeFiles.length > 0) {
          setActiveFile(codeFiles[0].name)
        }
      } catch (error) {
        console.error('Failed to load files:', error)
        message.error('Failed to load code files')
      } finally {
        setLoading(false)
      }
    }

    loadFiles()
  }, [overseer])

  // Handle file selection
  const handleFileSelect = (filename: string) => {
    setActiveFile(filename)
  }

  // Handle file saving
  const handleFileSave = async (filename: string, content: string) => {
    // Update local files state immediately to avoid race conditions
    setFiles(prev => prev.map(file => 
      file.name === filename 
        ? { ...file, content } 
        : file
    ))

    try {
      await overseer.setCodeFile(filename, content)
      onCodeChange?.()
    } catch (error) {
      console.error('Failed to save file:', error)
      // TODO: Could revert local state on error, but for now just log
      throw error // Re-throw so CodeEditor can handle the error
    }
  }

  // Handle file creation
  const handleFileCreate = async (filename: string) => {
    try {
      await overseer.setCodeFile(filename, '')
      
      // Add to local files state
      const newFile: CodeFile = { name: filename, content: '' }
      setFiles(prev => [...prev, newFile])
      setActiveFile(filename)
      
      onCodeChange?.()
      message.success(`Created file: ${filename}`)
    } catch (error) {
      console.error('Failed to create file:', error)
      message.error(`Failed to create file: ${filename}`)
    }
  }

  // Handle file deletion
  const handleFileDelete = async (filename: string) => {
    try {
      await overseer.deleteCodeFile(filename)
      
      // Remove from local files state and handle active file switching
      setFiles(prev => {
        const remainingFiles = prev.filter(f => f.name !== filename)
        
        // Switch to another file if the deleted file was active
        if (activeFile === filename) {
          setActiveFile(remainingFiles.length > 0 ? remainingFiles[0].name : null)
        }
        
        return remainingFiles
      })
      
      onCodeChange?.()
      message.success(`Deleted file: ${filename}`)
    } catch (error) {
      console.error('Failed to delete file:', error)
      message.error(`Failed to delete file: ${filename}`)
    }
  }

  // Handle file renaming
  const handleFileRename = async (oldName: string, newName: string) => {
    try {
      const file = files.find(f => f.name === oldName)
      if (!file) {
        message.error('File not found')
        return
      }

      // Create new file with new name
      await overseer.setCodeFile(newName, file.content)
      
      // Delete old file
      await overseer.deleteCodeFile(oldName)
      
      // Update local state
      setFiles(prev => prev.map(f => 
        f.name === oldName 
          ? { ...f, name: newName }
          : f
      ))
      
      // Update active file if it was the renamed file
      if (activeFile === oldName) {
        setActiveFile(newName)
      }
      
      onCodeChange?.()
      message.success(`Renamed file: ${oldName} → ${newName}`)
    } catch (error) {
      console.error('Failed to rename file:', error)
      message.error(`Failed to rename file: ${oldName}`)
    }
  }

  const activeFileObject = files.find(f => f.name === activeFile) || null

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
    <div style={{ display: 'flex', height }}>
      <FileSidebar
        files={files}
        activeFile={activeFile}
        onFileSelect={handleFileSelect}
        onFileCreate={handleFileCreate}
        onFileDelete={handleFileDelete}
        onFileRename={handleFileRename}
      />
      <div style={{ flex: 1 }}>
        <CodeEditor
          file={activeFileObject}
          onSave={handleFileSave}
          height="100%"
        />
      </div>
    </div>
  )
}