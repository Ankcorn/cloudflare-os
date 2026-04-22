import { useNavigate } from '@tanstack/react-router'
import { DropdownMenu } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../AuthContext'
import { useAvatar } from '../useAvatar'

export default function UserMenu() {
  const { authenticatedApi, logout, currentUser } = useAuthenticatedApi()
  const navigate = useNavigate()

  const avatarUrl = useAvatar(authenticatedApi, currentUser?.id)

  const initials = currentUser?.name
    ? currentUser.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
    : 'U'

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button className="w-8 h-8 rounded-full flex items-center justify-center bg-kumo-tint hover:bg-kumo-fill transition-colors overflow-hidden">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-xs font-medium text-kumo-strong">{initials}</span>
            )}
          </button>
        }
      />
      <DropdownMenu.Content>
        <DropdownMenu.Item onClick={() => navigate({ to: '/profile' })}>
          Profile
        </DropdownMenu.Item>
        <DropdownMenu.Item onClick={() => navigate({ to: '/providers' })}>
          Providers
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item variant="danger" onClick={logout}>
          Sign out
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
