import { useState } from 'react'
import { Dialog, Button, Input, useKumoToastManager } from '@cloudflare/kumo'
import { FileText, Plus, Trash, Pencil } from '@phosphor-icons/react'

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
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  const [deletingFile, setDeletingFile] = useState<string | null>(null)
  const [newFileName, setNewFileName] = useState('')
  const [renamingFile, setRenamingFile] = useState<string | null>(null)

  const toasts = useKumoToastManager()

  const handleCreateFile = () => {
    if (!newFileName.trim()) {
      toasts.add({ title: 'Filename cannot be empty', variant: 'error' })
      return
    }

    if (files.includes(newFileName.trim())) {
      toasts.add({ title: 'A file with this name already exists', variant: 'error' })
      return
    }

    onFileCreate(newFileName.trim())
    setNewFileName('')
    setIsCreateModalOpen(false)
  }

  const handleRenameFile = () => {
    if (!newFileName.trim() || !renamingFile) {
      toasts.add({ title: 'Filename cannot be empty', variant: 'error' })
      return
    }

    if (files.includes(newFileName.trim()) && newFileName.trim() !== renamingFile) {
      toasts.add({ title: 'A file with this name already exists', variant: 'error' })
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

  const startDelete = (filename: string) => {
    if (files.length <= 1) {
      toasts.add({ title: 'Cannot delete the last remaining file', variant: 'error' })
      return
    }
    setDeletingFile(filename)
    setIsDeleteModalOpen(true)
  }

  const confirmDelete = () => {
    if (deletingFile) {
      onFileDelete(deletingFile)
    }
    setDeletingFile(null)
    setIsDeleteModalOpen(false)
  }

  return (
    <div className="w-[250px] border-r border-kumo-line h-full flex flex-col">
      {/* New File button */}
      <div className="p-2 border-b border-kumo-line">
        <Button
          variant="primary"
          size="sm"
          className="w-full"
          onClick={() => setIsCreateModalOpen(true)}
        >
          <Plus size={14} />
          New File
        </Button>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-auto">
        {files.map(filename => {
          const isDirty = dirtyFiles.has(filename)
          const hasChanges = changedFiles?.has(filename) || false
          const isUnchanged = isDiffMode && !hasChanges
          const isActive = activeFile === filename

          return (
            <div
              key={filename}
              className={[
                'group flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm',
                isActive
                  ? 'bg-kumo-tint text-kumo-brand'
                  : 'text-kumo-default hover:bg-kumo-tint/50',
                isUnchanged ? 'opacity-40' : '',
              ].join(' ')}
              onClick={() => onFileSelect(filename)}
            >
              <FileText
                size={14}
                className={[
                  'shrink-0',
                  isDirty
                    ? 'text-kumo-danger'
                    : hasChanges
                      ? 'text-kumo-brand'
                      : 'text-kumo-subtle',
                ].join(' ')}
              />

              <span
                className={[
                  'flex-1 truncate',
                  isDirty
                    ? 'text-kumo-danger'
                    : hasChanges
                      ? 'text-kumo-brand'
                      : '',
                ].join(' ')}
                title={
                  isDirty
                    ? 'File has unsaved changes'
                    : hasChanges
                      ? 'File has proposed changes'
                      : filename
                }
              >
                {filename}
              </span>

              {/* Action buttons — visible on hover */}
              <div
                className="hidden group-hover:flex items-center gap-0.5"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  className="p-0.5 rounded text-kumo-subtle hover:text-kumo-default hover:bg-kumo-tint"
                  onClick={(e) => {
                    e.stopPropagation()
                    startRename(filename)
                  }}
                  aria-label={`Rename ${filename}`}
                >
                  <Pencil size={12} />
                </button>
                <button
                  className="p-0.5 rounded text-kumo-subtle hover:text-kumo-danger hover:bg-kumo-tint"
                  onClick={(e) => {
                    e.stopPropagation()
                    startDelete(filename)
                  }}
                  aria-label={`Delete ${filename}`}
                >
                  <Trash size={12} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Create File Dialog */}
      <Dialog.Root
        open={isCreateModalOpen}
        onOpenChange={(o) => {
          if (!o) {
            setIsCreateModalOpen(false)
            setNewFileName('')
          }
        }}
      >
        <Dialog className="p-6" size="sm">
          <Dialog.Title className="text-lg font-semibold mb-4">Create New File</Dialog.Title>
          <Input
            placeholder="Enter filename (e.g., main.ts, utils.js)"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFile() }}
            autoFocus
          />
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <Button variant="secondary" {...props}>Cancel</Button>
              )}
            />
            <Button variant="primary" onClick={handleCreateFile}>Create</Button>
          </div>
        </Dialog>
      </Dialog.Root>

      {/* Rename File Dialog */}
      <Dialog.Root
        open={isRenameModalOpen}
        onOpenChange={(o) => {
          if (!o) {
            setIsRenameModalOpen(false)
            setNewFileName('')
            setRenamingFile(null)
          }
        }}
      >
        <Dialog className="p-6" size="sm">
          <Dialog.Title className="text-lg font-semibold mb-4">Rename File</Dialog.Title>
          <Input
            placeholder="Enter new filename"
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRenameFile() }}
            autoFocus
          />
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <Button variant="secondary" {...props}>Cancel</Button>
              )}
            />
            <Button variant="primary" onClick={handleRenameFile}>Rename</Button>
          </div>
        </Dialog>
      </Dialog.Root>

      {/* Delete Confirmation Dialog */}
      <Dialog.Root
        role="alertdialog"
        open={isDeleteModalOpen}
        onOpenChange={(o) => {
          if (!o) {
            setIsDeleteModalOpen(false)
            setDeletingFile(null)
          }
        }}
      >
        <Dialog className="p-6" size="sm">
          <Dialog.Title className="text-lg font-semibold mb-2">Delete File</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">
            Are you sure you want to delete "{deletingFile}"?
          </Dialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close
              render={(props) => (
                <Button variant="secondary" {...props}>Cancel</Button>
              )}
            />
            <Button variant="destructive" onClick={confirmDelete}>Delete</Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  )
}
