import { useState, useEffect, useCallback } from 'react'
import { Modal, Tabs, Input, Button, Table, Space, Typography, message, Checkbox, Alert, Popconfirm, Tag } from 'antd'
import { CopyOutlined, DeleteOutlined, PlusOutlined, LinkOutlined, SyncOutlined, WarningOutlined } from '@ant-design/icons'
import { RpcStub } from 'capnweb'
import { Overseer, CollaboratorInfo, ShareKeyInfo, GadgetMetadata, AiChatAuthorInfo, BlueprintGadgetSummary } from '@gadgets/workshop-shared/api'

// Rows shown in the collaborator table: the owner (always first) plus actual collaborators.
type CollaboratorRow =
  | { kind: 'owner'; profile: AiChatAuthorInfo }
  | { kind: 'collaborator'; info: CollaboratorInfo }

const { Text } = Typography

function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSeconds < 60) return 'Just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

type Props = {
  open: boolean
  onClose: () => void
  overseer: RpcStub<Overseer>
  metadata: GadgetMetadata
  currentUser: AiChatAuthorInfo | null
}

export default function ShareModal({ open, onClose, overseer, metadata, currentUser }: Props) {
  const [collaborators, setCollaborators] = useState<CollaboratorInfo[]>([])
  const [shareKeys, setShareKeys] = useState<ShareKeyInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [addUsername, setAddUsername] = useState('')
  const [addNote, setAddNote] = useState('')
  const [adding, setAdding] = useState(false)
  const [shareKeyNote, setShareKeyNote] = useState('')
  const [newShareLink, setNewShareLink] = useState<string | null>(null)
  const [creatingKey, setCreatingKey] = useState(false)

  // Blueprint state
  const [blueprints, setBlueprints] = useState<BlueprintGadgetSummary[]>([])
  const [blueprintsLoading, setBlueprintsLoading] = useState(false)
  const [newBpTitle, setNewBpTitle] = useState('')
  const [newBpDescription, setNewBpDescription] = useState('')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [creatingBp, setCreatingBp] = useState(false)
  const [editingBpTitle, setEditingBpTitle] = useState<string | null>(null)
  const [editingBpDesc, setEditingBpDesc] = useState<string | null>(null)
  const [editTitleValue, setEditTitleValue] = useState('')
  const [editDescValue, setEditDescValue] = useState('')

  const isOwner = !metadata.owner

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [collabs, keys] = await Promise.all([
        overseer.listCollaborators(),
        overseer.listShareKeys(),
      ])
      setCollaborators(collabs)
      setShareKeys(keys)
    } catch (err) {
      console.error('Failed to load share data:', err)
    } finally {
      setLoading(false)
    }
  }, [overseer])

  const loadBlueprints = useCallback(async () => {
    setBlueprintsLoading(true)
    try {
      const bps = await overseer.listBlueprints()
      setBlueprints(bps)
    } catch (err) {
      console.error('Failed to load blueprints:', err)
    } finally {
      setBlueprintsLoading(false)
    }
  }, [overseer])

  useEffect(() => {
    if (open) {
      loadData()
      loadBlueprints()
      setNewShareLink(null)
    }
  }, [open, loadData, loadBlueprints])

  const handleAddCollaborator = async () => {
    if (!addUsername.trim()) return
    setAdding(true)
    try {
      const result = await overseer.addCollaborator(
        addUsername.trim(),
        addNote.trim() || undefined
      )
      if (result === null) {
        message.error('No account found for that username.')
      } else {
        message.success(`Added ${result.profile.name} as a collaborator.`)
        setAddUsername('')
        setAddNote('')
        await loadData()
      }
    } catch (err: any) {
      message.error(err.message || 'Failed to add collaborator.')
    } finally {
      setAdding(false)
    }
  }

  const handleRemoveCollaborator = async (profileId: string) => {
    try {
      // Preview first to check for dependent users.
      const dependents = await overseer.previewRemoveCollaborator(profileId)

      if (dependents.length === 0) {
        // Simple removal, confirm directly.
        Modal.confirm({
          title: 'Remove Collaborator',
          content: 'Are you sure you want to remove this collaborator?',
          okText: 'Remove',
          okType: 'danger',
          onOk: async () => {
            let removed = await overseer.removeCollaborator(profileId, [])
            message.success(removed.length > 0
                ? 'Collaborator removed.'
                : 'Your sharing link with this collaborator was removed.')
            await loadData()
          }
        })
      } else {
        // Show dependent users dialog.
        showDependentUsersDialog({
          title: 'Remove Collaborator',
          description: 'This user shared with other users who will be removed as well, unless you choose to keep them.',
          dependents,
          onConfirm: async (keepUsers) => {
            await overseer.removeCollaborator(profileId, keepUsers)
            message.success('Collaborator removed.')
            await loadData()
          },
        })
      }
    } catch (err: any) {
      message.error(err.message || 'Failed to remove collaborator.')
    }
  }

  const showDependentUsersDialog = (opts: {
    title: string,
    description: string,
    dependents: CollaboratorInfo[],
    onConfirm: (keepUsers: string[]) => Promise<void>,
  }) => {
    let keepSet = new Set<string>()

    const DependentUsersContent = () => {
      const [kept, setKept] = useState(keepSet)

      return (
        <div>
          <Text>{opts.description}</Text>
          <div style={{ marginTop: 12 }}>
            <Text strong style={{ display: 'block', marginBottom: 8 }}>Keep?</Text>
            {opts.dependents.map(dep => (
              <div key={dep.profile.id} style={{ marginBottom: 8 }}>
                <Checkbox
                  checked={kept.has(dep.profile.id)}
                  onChange={(e) => {
                    const next = new Set(kept)
                    if (e.target.checked) {
                      next.add(dep.profile.id)
                    } else {
                      next.delete(dep.profile.id)
                    }
                    setKept(next)
                    keepSet = next
                  }}
                >
                  {dep.profile.name} ({dep.profile.id})
                </Checkbox>
              </div>
            ))}
          </div>
        </div>
      )
    }

    Modal.confirm({
      title: opts.title,
      width: 480,
      content: <DependentUsersContent />,
      okText: 'Confirm',
      okType: 'danger',
      onOk: () => opts.onConfirm([...keepSet]),
    })
  }

  const handleCreateShareKey = async () => {
    setCreatingKey(true)
    try {
      const { key } = await overseer.createShareKey(shareKeyNote.trim() || undefined)
      const url = `${window.location.origin}/gadget/${metadata.id}#share=${key}`
      setNewShareLink(url)
      setShareKeyNote('')
      await loadData()
    } catch (err: any) {
      message.error(err.message || 'Failed to create share link.')
    } finally {
      setCreatingKey(false)
    }
  }

  const handleRevokeShareKey = async (keyId: string) => {
    try {
      // Preview first to check for dependent users.
      const dependents = await overseer.previewRevokeShareKey(keyId)

      if (dependents.length === 0) {
        // No users will lose access — simple confirm.
        Modal.confirm({
          title: 'Revoke Share Link',
          content: 'This will prevent anyone from using this link to gain access.',
          okText: 'Revoke',
          okType: 'danger',
          onOk: async () => {
            await overseer.revokeShareKey(keyId, [])
            message.success('Share link revoked.')
            await loadData()
          }
        })
      } else {
        // Some users would lose access — show dependent users dialog.
        showDependentUsersDialog({
          title: 'Revoke Share Link',
          description: 'Revoking this share link will also remove the following users who gained access through it, unless you choose to keep them.',
          dependents,
          onConfirm: async (keepUsers) => {
            await overseer.revokeShareKey(keyId, keepUsers)
            message.success('Share link revoked.')
            await loadData()
          },
        })
      }
    } catch (err: any) {
      message.error(err.message || 'Failed to revoke share link.')
    }
  }

  const handleCopyLink = (url: string) => {
    navigator.clipboard.writeText(url)
    message.success('Link copied to clipboard.')
  }

  const describeEdge = (info: CollaboratorInfo): string => {
    const parts: string[] = []
    for (const edge of info.addedBy) {
      if (edge.type === 'user') {
        parts.push(`Added by ${edge.sharer}`)
      } else {
        parts.push('Via share link')
      }
    }
    return parts.join(', ') || 'Unknown'
  }

  // The owner profile: if the current user IS the owner, use their own profile;
  // otherwise use the owner info from metadata.
  const ownerProfile: AiChatAuthorInfo | null = isOwner ? currentUser : (metadata.owner ?? null)

  // Build combined rows: owner first, then collaborators.
  const collaboratorRows: CollaboratorRow[] = [
    ...(ownerProfile ? [{ kind: 'owner' as const, profile: ownerProfile }] : []),
    ...collaborators.map(info => ({ kind: 'collaborator' as const, info })),
  ]

  const collaboratorColumns = [
    {
      title: 'Name',
      key: 'name',
      render: (_: any, record: CollaboratorRow) => {
        const profile = record.kind === 'owner' ? record.profile : record.info.profile
        return (
          <div>
            <Text strong>{profile.name}</Text>
            <br />
            <Text type="secondary" style={{ fontSize: 12 }}>{profile.id}</Text>
          </div>
        )
      },
    },
    {
      title: 'Relationship',
      key: 'relationship',
      render: (_: any, record: CollaboratorRow) => (
        <Text type="secondary">
          {record.kind === 'owner' ? 'Owner' : describeEdge(record.info)}
        </Text>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_: any, record: CollaboratorRow) => {
        if (record.kind === 'owner') return null
        return (
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleRemoveCollaborator(record.info.profile.id)}
            title="Remove"
          />
        )
      },
    },
  ]

  const shareKeyColumns = [
    {
      title: 'Note',
      key: 'note',
      render: (_: any, record: ShareKeyInfo) => (
        <Text>{record.note || '(no note)'}</Text>
      ),
    },
    {
      title: 'Created',
      key: 'created',
      render: (_: any, record: ShareKeyInfo) => (
        <Text type="secondary">{formatRelativeTime(record.created)}</Text>
      ),
    },
    {
      title: 'Created by',
      key: 'createdBy',
      render: (_: any, record: ShareKeyInfo) => (
        <Text type="secondary">{record.createdBy.name}</Text>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      render: (_: any, record: ShareKeyInfo) => (
        <Button
          type="text"
          size="small"
          danger
          icon={<DeleteOutlined />}
          onClick={() => handleRevokeShareKey(record.keyId)}
          title="Revoke"
        />
      ),
    },
  ]

  return (
    <Modal
      title="Share"
      open={open}
      onCancel={onClose}
      footer={null}
      width={640}
    >
      <Tabs
        defaultActiveKey="collaborators"
        items={[
          {
            key: 'blueprints',
            label: 'Blueprints',
            children: (
              <div>
                {/* Existing blueprints */}
                {blueprints.map(bp => (
                  <div key={bp.id} style={{
                    padding: '12px',
                    background: '#fafafa',
                    borderRadius: 4,
                    marginBottom: 8,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      {editingBpTitle === bp.id ? (
                        <Space.Compact style={{ flex: 1 }}>
                          <Input
                            value={editTitleValue}
                            onChange={(e) => setEditTitleValue(e.target.value)}
                            size="small"
                            onPressEnter={async () => {
                              await overseer.updateBlueprint(bp.id, { title: editTitleValue })
                              setEditingBpTitle(null)
                              loadBlueprints()
                            }}
                          />
                          <Button size="small" type="primary" onClick={async () => {
                            await overseer.updateBlueprint(bp.id, { title: editTitleValue })
                            setEditingBpTitle(null)
                            loadBlueprints()
                          }}>Save</Button>
                          <Button size="small" onClick={() => setEditingBpTitle(null)}>Cancel</Button>
                        </Space.Compact>
                      ) : (
                        <Text strong style={{ cursor: 'pointer', flex: 1 }} onClick={() => {
                          setEditingBpTitle(bp.id)
                          setEditTitleValue(bp.title)
                        }}>{bp.title}</Text>
                      )}
                      {bp.dirty && (
                        <Tag icon={<WarningOutlined />} color="warning">
                          Publish failed
                        </Tag>
                      )}
                    </div>

                    {editingBpDesc === bp.id ? (
                      <div style={{ marginBottom: 8 }}>
                        <Input.TextArea
                          value={editDescValue}
                          onChange={(e) => setEditDescValue(e.target.value)}
                          rows={2}
                          size="small"
                        />
                        <Space style={{ marginTop: 4 }}>
                          <Button size="small" type="primary" onClick={async () => {
                            await overseer.updateBlueprint(bp.id, { description: editDescValue })
                            setEditingBpDesc(null)
                            loadBlueprints()
                          }}>Save</Button>
                          <Button size="small" onClick={() => setEditingBpDesc(null)}>Cancel</Button>
                        </Space>
                      </div>
                    ) : (
                      <Text type="secondary" style={{ fontSize: 12, cursor: 'pointer', display: 'block', marginBottom: 4 }}
                        onClick={() => {
                          setEditingBpDesc(bp.id)
                          setEditDescValue(bp.description)
                        }}>
                        {bp.description || '(click to add description)'}
                      </Text>
                    )}

                    <Text type="secondary" style={{ fontSize: 12 }}>
                      v{bp.version} - Code from {new Date(bp.codeVersionDate).toLocaleDateString()}
                    </Text>

                    <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
                      <Button size="small" onClick={async () => {
                        try {
                          await overseer.updateBlueprint(bp.id, { updateCode: true })
                          message.success('Blueprint updated to current code.')
                          loadBlueprints()
                        } catch (err: any) {
                          message.error(err.message || 'Failed to update blueprint.')
                        }
                      }}>
                        <SyncOutlined /> Update code
                      </Button>
                      <Button size="small" icon={<CopyOutlined />} onClick={() => {
                        let url = `${window.location.origin}/blueprint/${bp.id}`
                        navigator.clipboard.writeText(url)
                        message.success('Blueprint link copied.')
                      }}>
                        Copy link
                      </Button>
                      {bp.dirty && (
                        <Button size="small" onClick={async () => {
                          try {
                            await overseer.retryBlueprintPublish(bp.id)
                            message.success('Blueprint published successfully.')
                            loadBlueprints()
                          } catch (err: any) {
                            message.error(err.message || 'Retry failed.')
                          }
                        }}>
                          Retry publish
                        </Button>
                      )}
                      <Popconfirm
                        title="Delete this blueprint?"
                        description="This cannot be undone."
                        onConfirm={async () => {
                          try {
                            await overseer.deleteBlueprint(bp.id)
                            message.success('Blueprint deleted.')
                            loadBlueprints()
                          } catch (err: any) {
                            message.error(err.message || 'Failed to delete blueprint.')
                          }
                        }}
                        okText="Delete"
                        okType="danger"
                      >
                        <Button size="small" danger icon={<DeleteOutlined />}>Delete</Button>
                      </Popconfirm>
                    </div>
                  </div>
                ))}

                {blueprints.length === 0 && !blueprintsLoading && (
                  <div style={{ textAlign: 'center', padding: '16px 0' }}>
                    <Text type="secondary">No blueprints yet.</Text>
                  </div>
                )}

                {/* Create new blueprint */}
                {showCreateForm ? (
                  <div style={{ marginTop: 16, padding: 12, background: '#fafafa', borderRadius: 4 }}>
                    <Text strong>New Blueprint</Text>
                    <Input
                      placeholder="Title"
                      value={newBpTitle}
                      onChange={(e) => setNewBpTitle(e.target.value)}
                      style={{ marginTop: 8 }}
                    />
                    <Input.TextArea
                      placeholder="Description (optional)"
                      value={newBpDescription}
                      onChange={(e) => setNewBpDescription(e.target.value)}
                      rows={2}
                      style={{ marginTop: 8 }}
                    />
                    <Space style={{ marginTop: 8 }}>
                      <Button
                        type="primary"
                        loading={creatingBp}
                        onClick={async () => {
                          setCreatingBp(true)
                          try {
                            await overseer.createBlueprint(
                              newBpTitle.trim() || undefined,
                              newBpDescription.trim() || undefined,
                            )
                            message.success('Blueprint created.')
                            setShowCreateForm(false)
                            setNewBpTitle('')
                            setNewBpDescription('')
                            loadBlueprints()
                          } catch (err: any) {
                            message.error(err.message || 'Failed to create blueprint.')
                          } finally {
                            setCreatingBp(false)
                          }
                        }}
                      >
                        Create
                      </Button>
                      <Button onClick={() => {
                        setShowCreateForm(false)
                        setNewBpTitle('')
                        setNewBpDescription('')
                      }}>
                        Cancel
                      </Button>
                    </Space>
                  </div>
                ) : (
                  <Button
                    type="dashed"
                    icon={<PlusOutlined />}
                    block
                    style={{ marginTop: 12 }}
                    onClick={() => {
                      setNewBpTitle(metadata.title)
                      setShowCreateForm(true)
                    }}
                  >
                    Create Blueprint
                  </Button>
                )}
              </div>
            ),
          },
          {
            key: 'collaborators',
            label: 'Collaborators',
            children: (
              <div>
                {/* Add collaborator */}
                <div style={{ marginBottom: 16 }}>
                  <Text strong>Add collaborator</Text>
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <Input
                      placeholder="Username or email"
                      value={addUsername}
                      onChange={(e) => setAddUsername(e.target.value)}
                      onPressEnter={handleAddCollaborator}
                      style={{ flex: 1 }}
                    />
                    <Button
                      type="primary"
                      icon={<PlusOutlined />}
                      onClick={handleAddCollaborator}
                      loading={adding}
                      disabled={!addUsername.trim()}
                    >
                      Add
                    </Button>
                  </div>
                </div>

                {/* Collaborator list (owner always first) */}
                <Table
                  columns={collaboratorColumns}
                  dataSource={collaboratorRows}
                  rowKey={(r) => r.kind === 'owner' ? '__owner__' : r.info.profile.id}
                  loading={loading}
                  pagination={false}
                  size="small"
                  style={{ marginBottom: 24 }}
                />

                {/* Share links */}
                <Text strong>Share links</Text>
                <div style={{ display: 'flex', gap: 8, marginTop: 8, marginBottom: 12 }}>
                  <Input
                    placeholder="Note (optional)"
                    value={shareKeyNote}
                    onChange={(e) => setShareKeyNote(e.target.value)}
                    onPressEnter={handleCreateShareKey}
                    style={{ flex: 1 }}
                  />
                  <Button
                    icon={<LinkOutlined />}
                    onClick={handleCreateShareKey}
                    loading={creatingKey}
                  >
                    Create link
                  </Button>
                </div>

                {newShareLink && (
                  <Alert
                    message="Share link created"
                    description={
                      <Space direction="vertical" style={{ width: '100%' }}>
                        <Text type="secondary">This link won't be shown again.</Text>
                        <Space.Compact style={{ width: '100%' }}>
                          <Input value={newShareLink} readOnly />
                          <Button
                            icon={<CopyOutlined />}
                            onClick={() => handleCopyLink(newShareLink)}
                          >
                            Copy
                          </Button>
                        </Space.Compact>
                      </Space>
                    }
                    type="success"
                    closable
                    onClose={() => setNewShareLink(null)}
                    style={{ marginBottom: 12 }}
                  />
                )}

                <Table
                  columns={shareKeyColumns}
                  dataSource={shareKeys}
                  rowKey="keyId"
                  loading={loading}
                  pagination={false}
                  size="small"
                  locale={{ emptyText: 'No share links.' }}
                />
              </div>
            ),
          },
        ]}
      />
    </Modal>
  )
}
