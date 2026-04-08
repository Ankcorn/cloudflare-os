import { Input, SensitiveInput, Button, useKumoToastManager } from '@cloudflare/kumo'
import { useAuthenticatedApi } from './AuthContext'
import { useState, useEffect } from 'react'
import { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { hashPassword } from './passwordHash'
import { CF_ACCESS_MODE } from './useAuth'
import { User, Pencil, Check, X, Lock } from '@phosphor-icons/react'

export default function SettingsPage() {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [userInfo, setUserInfo] = useState<AiChatAuthorInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [isEditingName, setIsEditingName] = useState(false)
  const [nameInput, setNameInput] = useState('')

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordLoading, setPasswordLoading] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)

  // Fetch user info
  useEffect(() => {
    let cancelled = false
    const fetchUserInfo = async () => {
      try {
        const info = await authenticatedApi.whoami()
        if (cancelled) return
        setUserInfo(info)
        setNameInput(info.name)
      } catch (error) {
        console.error('Failed to fetch user info:', error)
        if (!cancelled) toasts.add({ title: 'Failed to load user information', variant: 'error' })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchUserInfo()
    return () => { cancelled = true }
  }, [authenticatedApi])

  const handleSaveName = async () => {
    if (!nameInput.trim()) {
      toasts.add({ title: 'Display name cannot be empty', variant: 'error' })
      return
    }

    try {
      await authenticatedApi.setOwnDisplayName(nameInput.trim())
      setUserInfo(prev => prev ? { ...prev, name: nameInput.trim() } : null)
      setIsEditingName(false)
      toasts.add({ title: 'Display name updated', variant: 'success' })
    } catch (err) {
      console.error('Failed to update display name:', err)
      toasts.add({ title: 'Failed to update display name', variant: 'error' })
    }
  }

  const handleCancelEdit = () => {
    setNameInput(userInfo?.name || '')
    setIsEditingName(false)
  }

  const handleChangePassword = async () => {
    if (!userInfo) return
    if (!currentPassword || !newPassword || !confirmPassword) return
    if (newPassword.length < 8) {
      setPasswordError('Password must be at least 8 characters')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match')
      return
    }

    setPasswordLoading(true)
    setPasswordError(null)

    try {
      const oldHash = await hashPassword(userInfo.id, currentPassword)
      const newHash = await hashPassword(userInfo.id, newPassword)
      await authenticatedApi.changePassword(oldHash, newHash)
      toasts.add({ title: 'Password changed successfully', variant: 'success' })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to change password'
      setPasswordError(errorMessage)
    } finally {
      setPasswordLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center min-h-[60vh]">
        <p className="text-kumo-subtle">Loading profile...</p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {/* Profile Section */}
      <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
        <h2 className="text-lg font-semibold text-kumo-strong mb-6">Profile</h2>

        <div className="space-y-6">
          {/* Avatar */}
          <div className="flex flex-col items-center gap-2">
            <div className="w-20 h-20 rounded-full bg-kumo-tint flex items-center justify-center">
              <User size={32} className="text-kumo-subtle" />
            </div>
            <p className="text-xs text-kumo-subtle">Avatar customization coming soon</p>
          </div>

          {/* Display Name */}
          <div>
            {isEditingName ? (
              <div className="flex gap-2 items-end">
                <div className="flex-1">
                  <Input
                    label="Display Name"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSaveName() }}
                    placeholder="Enter display name"
                    autoFocus
                  />
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSaveName}
                  disabled={!nameInput.trim()}
                >
                  <Check size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCancelEdit}
                >
                  <X size={14} />
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-kumo-subtle mb-1">Display Name</p>
                  <p className="text-sm text-kumo-default">{userInfo?.name}</p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsEditingName(true)}
                >
                  <Pencil size={14} />
                </Button>
              </div>
            )}
          </div>

          {/* User ID */}
          <div>
            <p className="text-xs font-medium text-kumo-subtle mb-1">User ID</p>
            <p className="text-sm text-kumo-default font-mono">{userInfo?.id}</p>
          </div>
        </div>
      </div>

      {/* Change Password — only in password-auth mode, not CF Access */}
      {!CF_ACCESS_MODE && (
        <div className="bg-kumo-elevated border border-kumo-line rounded-xl p-6">
          <h2 className="text-lg font-semibold text-kumo-strong mb-6">Change Password</h2>

          <div className="space-y-4 max-w-sm">
            <SensitiveInput
              label="Current Password"
              value={currentPassword}
              onValueChange={setCurrentPassword}
              placeholder="Enter current password"
              autoComplete="current-password"
            />

            <SensitiveInput
              label="New Password"
              value={newPassword}
              onValueChange={setNewPassword}
              placeholder="Enter new password"
              description="Must be at least 8 characters"
              autoComplete="new-password"
            />

            <SensitiveInput
              label="Confirm New Password"
              value={confirmPassword}
              onValueChange={setConfirmPassword}
              placeholder="Confirm new password"
              autoComplete="new-password"
              error={passwordError || undefined}
              variant={passwordError ? 'error' : 'default'}
            />

            <div className="pt-2">
              <Button
                variant="primary"
                onClick={handleChangePassword}
                loading={passwordLoading}
                disabled={!currentPassword || !newPassword || !confirmPassword}
              >
                <Lock size={14} className="mr-1.5" />
                Change Password
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
