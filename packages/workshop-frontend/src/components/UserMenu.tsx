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
          <button
            className="w-8 h-8 cursor-pointer rounded-full flex items-center justify-center bg-kumo-tint hover:bg-kumo-fill transition-colors overflow-hidden"
            title="Open profile menu"
            aria-label="Open profile menu"
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-xs font-medium text-kumo-strong">{initials}</span>
            )}
          </button>
        }
      />
      <DropdownMenu.Content className="!z-[1100] !min-w-[160px] rounded-lg border border-kumo-line bg-kumo-base p-1 shadow-[0_10px_24px_rgba(82,16,0,0.10)]">
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/profile' })}
          className="!h-auto rounded-md !px-3 !py-2 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
        >
          Profile
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => navigate({ to: '/providers' })}
          className="!h-auto rounded-md !px-3 !py-2 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
        >
          Providers
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Item
          variant="danger"
          onClick={logout}
          className="!h-auto rounded-md !px-3 !py-2 text-[13px] leading-[18px] font-normal tracking-[-0.25px] transition-colors data-highlighted:bg-kumo-danger-tint"
        >
          Sign out
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
