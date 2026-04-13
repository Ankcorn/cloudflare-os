import { useEffect } from 'react'
import { createRootRoute, Outlet, useRouterState } from '@tanstack/react-router'
import { TooltipProvider, Toasty } from '@cloudflare/kumo'
import { useRpcStub, useConnectionLost } from '../RpcContext'
import { markConnectionRestored } from '../main'
import { useAuth, CF_ACCESS_MODE } from '../useAuth'
import { AuthProvider } from '../AuthContext'
import Header from '../components/Header'
import LoginPage from '../LoginPage'

export const Route = createRootRoute({
  component: RootComponent,
})

function ConnectionLostBanner() {
  return (
    <div className="sticky top-0 z-[100] bg-kumo-warning-tint border-b border-kumo-warning/30 px-4 py-2 text-center text-sm text-kumo-warning">
      Connection lost — reconnecting…
    </div>
  )
}

function RootComponent() {
  const rpcStub = useRpcStub()
  const connectionLost = useConnectionLost()
  const { isAuthenticated, authenticatedApi, isLoading, error, logout, login } = useAuth(rpcStub)
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // When authenticatedApi becomes available, the connection is proven alive.
  useEffect(() => {
    if (authenticatedApi) markConnectionRestored()
  }, [authenticatedApi])

  // Routes that don't require auth (public routes)
  const isPublicRoute = pathname === '/signup' || pathname.startsWith('/blueprint/')

  // Chat routes hide the header (fullscreen mode)
  const isChat = pathname.startsWith('/chat/')
  // Gadget editor also fullscreen
  const isGadgetEditor = pathname.startsWith('/gadget/')

  const handleLoginSuccess = () => {
    const token = localStorage.getItem('authToken')
    if (token) {
      login(token)
    }
  }

  // Loading state
  if (isLoading && !isPublicRoute) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-4 bg-kumo-base">
        {connectionLost && <ConnectionLostBanner />}
        <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-kumo-subtle">{connectionLost ? 'Waiting for server…' : 'Loading...'}</p>
      </div>
    )
  }

  // Auth error
  if (error && !isPublicRoute) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-4 bg-kumo-base p-6">
        <p className="text-sm text-kumo-danger">Authentication error: {error}</p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 text-sm font-medium text-kumo-inverse bg-kumo-brand rounded-lg hover:bg-kumo-brand-hover transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  // CF Access mode: show spinner while pipelined auth resolves
  if (!isAuthenticated && CF_ACCESS_MODE && !isPublicRoute) {
    return (
      <div className="min-h-screen flex items-center justify-center flex-col gap-4 bg-kumo-base">
        <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-kumo-subtle">Authenticating...</p>
      </div>
    )
  }

  // Not authenticated and not a public route — show login
  if (!isAuthenticated && !isPublicRoute) {
    return <LoginPage rpcStub={rpcStub} onLoginSuccess={handleLoginSuccess} />
  }

  // For public routes (signup, blueprint) render without auth wrapper
  if (isPublicRoute) {
    const showHeader = pathname !== '/signup'
    return (
      <TooltipProvider>
        <Toasty>
          {showHeader && <Header />}
          <Outlet />
        </Toasty>
      </TooltipProvider>
    )
  }

  // Authenticated — render the full shell
  // authenticatedApi is guaranteed non-null here: isLoading, error, and
  // !isAuthenticated branches all return early above.
  if (!authenticatedApi) return null
  return (
    <AuthProvider authenticatedApi={authenticatedApi} onLogout={logout}>
      <TooltipProvider>
        <Toasty>
          {connectionLost && <ConnectionLostBanner />}
          {!isChat && !isGadgetEditor && <Header />}
          <main className={!isChat && !isGadgetEditor ? 'dotted-bg' : ''}>
            <Outlet />
          </main>
        </Toasty>
      </TooltipProvider>
    </AuthProvider>
  )
}
