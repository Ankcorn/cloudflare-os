import { useState } from 'react'
import { Menu, Button, Input, Modal, message } from 'antd'
import { FileOutlined, PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons'

interface FileSidebarProps {
  files: string[]
  activeFile: string | null
  dirtyFiles: Set<string>
  changedFiles?: Set<string>  // Files with proposed changes (for diff mode)
  isDiffMode?: boolean         // Whether we're in diff mode
  onFileSelect: (filename: string) => void
  onFileCreate: (filename: string) => void
  onFileDelete: (filename: string) => void
  onFileRename: (oldName: string, newName: string) => void
}

export default function FileSidebar({
  files,
  activeFile,
  dirtyFiles,
  changedFiles,
  isDiffMode = false,
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

    if (files.includes(newFileName.trim())) {
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

    if (files.includes(newFileName.trim()) && newFileName.trim() !== renamingFile) {
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

  const menuItems = files.map(filename => {
    const isDirty = dirtyFiles.has(filename)
    const hasChanges = changedFiles?.has(filename) || false
    const isUnchanged = isDiffMode && !hasChanges

    return {
      key: filename,
      icon: <FileOutlined />,
      label: (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            width: '100%',
            backgroundColor: isDirty
              ? 'rgba(255, 77, 79, 0.1)'
              : hasChanges
                ? 'rgba(24, 144, 255, 0.1)'
                : 'transparent',
            borderRadius: '4px',
            padding: (isDirty || hasChanges) ? '2px 4px' : '0',
            opacity: isUnchanged ? 0.4 : 1
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          <span
            style={{
              flex: 1,
              cursor: 'pointer',
              color: isDirty
                ? '#ff4d4f'
                : hasChanges
                  ? '#1890ff'
                  : 'inherit'
            }}
            onClick={() => onFileSelect(filename)}
            title={isDirty
              ? 'File has unsaved changes'
              : hasChanges
                ? 'File has proposed changes'
                : ''}
          >
            {filename}
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
              startRename(filename)
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
                content: `Are you sure you want to delete "${filename}"?`,
                okText: 'Delete',
                okType: 'danger',
                onOk: () => onFileDelete(filename)
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
  }
  })

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