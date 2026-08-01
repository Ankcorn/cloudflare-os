import { createFileRoute } from '@tanstack/react-router'
import { useRpcStub } from '../RpcContext'
import { CF_ACCESS_MODE } from '../useAuth'
import { Navigate } from '@tanstack/react-router'
import SignupPage from '../SignupPage'

type SignupSearch = {
  // Username to prefill, from the deploy wizard's setup link.
  username?: string
}

export const Route = createFileRoute('/signup')({
  component: SignupRoute,
  validateSearch: (search: Record<string, unknown>): SignupSearch => ({
    username: typeof search.username === 'string' && search.username !== ''
      ? search.username
      : undefined,
  }),
})

function SignupRoute() {
  const rpcStub = useRpcStub()
  const { username } = Route.useSearch()
  // The setup token travels in the URL fragment (like #share=) so it never reaches server logs.
  const hash = window.location.hash
  const setupToken = hash.startsWith('#setup=')
    ? decodeURIComponent(hash.slice('#setup='.length))
    : undefined
  // Signup is not available in CF Access mode — identity is managed by Access.
  if (CF_ACCESS_MODE) {
    return <Navigate to="/" replace />
  }
  return <SignupPage rpcStub={rpcStub} initialUsername={username} setupToken={setupToken} />
}
