import { useState } from 'react'
import { Menu, Button, Input, Modal, message } from 'antd'
import { FileOutlined, PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons'
import { CodeFile } from '@minions/workshop-shared/api'

interface FileSidebarProps {
  files: CodeFile[]
  activeFile: string | null
  onFileSelect: (filename: string) => void
  onFileCreate: (filename: string) => void
  onFileDelete: (filename: string) => void
  onFileRename: (oldName: string, newName: string) => void
}

export default function FileSidebar({
  files,
  activeFile,
  onFileSelect,
  onFileCreate,
  onFileDelete,
  onFileRename
}: FileSidebarProps) {
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [isRenameModalOpen, setIsRenameModalOpen] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [renamingFile, setRenamingFile] = useState<string | null>(null)

  const handleCreateFile = () => {
    if (!newFileName.trim()) {
      message.error('Filename cannot be empty')
      return
    }
    
    if (files.some(f => f.name === newFileName.trim())) {
      message.error('A file with this name already exists')
      return
    }
    
    onFileCreate(newFileName.trim())
    setNewFileName('')
    setIsCreateModalOpen(false)
  }

  const handleRenameFile = () => {
    if (!newFileName.trim() || !renamingFile) {
      message.error('Filename cannot be empty')
      return
    }
    
    if (files.some(f => f.name === newFileName.trim() && f.name !== renamingFile)) {
      message.error('A file with this name already exists')
      return
    }
    
    onFileRename(renamingFile, newFileName.trim())
    setNewFileName('')
    setRenamingFile(null)
    setIsRenameModalOpen(false)
  }

  const startRename = (filename: string) => {
    setRenamingFile(filename)
    setNewFileName(filename)
    setIsRenameModalOpen(true)
  }

  const menuItems = files.map(file => ({
    key: file.name,
    icon: <FileOutlined />,
    label: (
      <div 
        style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          width: '100%'
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        <span 
          style={{ flex: 1, cursor: 'pointer' }}
          onClick={() => onFileSelect(file.name)}
        >
          {file.name}
        </span>
        <div 
          style={{ 
            display: 'flex', 
            gap: 4,
            opacity: 0.6
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={(e) => {
              e.stopPropagation()
              startRename(file.name)
            }}
            style={{ 
              width: 20, 
              height: 20, 
              minWidth: 'unset',
              fontSize: '10px'
            }}
          />
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={(e) => {
              e.stopPropagation()
              if (files.length <= 1) {
                message.error('Cannot delete the last remaining file')
                return
              }
              Modal.confirm({
                title: 'Delete File',
                content: `Are you sure you want to delete "${file.name}"?`,
                okText: 'Delete',
                okType: 'danger',
                onOk: () => onFileDelete(file.name)
              })
            }}
            style={{ 
              width: 20, 
              height: 20, 
              minWidth: 'unset',
              fontSize: '10px'
            }}
          />
        </div>
      </div>
    )
  }))

  return (
    <div style={{ width: 250, borderRight: '1px solid #f0f0f0', height: '100%' }}>
      <div style={{ padding: '8px', borderBottom: '1px solid #f0f0f0' }}>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => setIsCreateModalOpen(true)}
          size="small"
          style={{ width: '100%' }}
        >
          New File
        </Button>
      </div>
      
      <Menu
        mode="inline"
        selectedKeys={activeFile ? [activeFile] : []}
        items={menuItems}
        style={{ 
          border: 'none',
          height: 'calc(100% - 48px)',
          overflow: 'auto'
        }}
      />

      <Modal
        title="Create New File"
        open={isCreateModalOpen}
        onOk={handleCreateFile}
        onCancel={() => {
          setIsCreateModalOpen(false)
          setNewFileName('')
        }}
        okText="Create"
      >
        <Input
          placeholder="Enter filename (e.g., main.ts, utils.js)"
          value={newFileName}
          onChange={(e) => setNewFileName(e.target.value)}
          onPressEnter={handleCreateFile}
          autoFocus
        />
      </Modal>

      <Modal
        title="Rename File"
        open={isRenameModalOpen}
        onOk={handleRenameFile}
        onCancel={() => {
          setIsRenameModalOpen(false)
          setNewFileName('')
          setRenamingFile(null)
        }}
        okText="Rename"
      >
        <Input
          placeholder="Enter new filename"
          value={newFileName}
          onChange={(e) => setNewFileName(e.target.value)}
          onPressEnter={handleRenameFile}
          autoFocus
        />
      </Modal>
    </div>
  )
}