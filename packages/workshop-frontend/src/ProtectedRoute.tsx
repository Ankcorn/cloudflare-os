import { ReactNode } from 'react'
import { RpcStub } from '@cloudflare/jsrpc'
import { PublicApi } from '@minions/workshop-shared/api'
import { useAuth } from './useAuth'
import { AuthProvider } from './AuthContext'
import LoginPage from './LoginPage'
import { Box, CircularProgress, Alert, Button } from '@mui/material'

interface ProtectedRouteProps {
  children: ReactNode
  rpcStub: RpcStub<PublicApi>
}

export default function ProtectedRoute({ children, rpcStub }: ProtectedRouteProps) {
  const { isAuthenticated, authenticatedApi, isLoading, error, logout, login } = useAuth(rpcStub)

  const handleLoginSuccess = () => {
    // Trigger re-authentication by calling login with stored token
    const token = localStorage.getItem('authToken')
    if (token) {
      login(token)
    }
  }

  if (isLoading) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <CircularProgress />
        <Box sx={{ textAlign: 'center' }}>
          Loading...
        </Box>
      </Box>
    )
  }

  if (error) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 2,
          p: 3,
        }}
      >
        <Alert severity="error" sx={{ mb: 2 }}>
          Authentication error: {error}
        </Alert>
        <Button variant="contained" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </Box>
    )
  }

  if (!isAuthenticated) {
    return <LoginPage rpcStub={rpcStub} onLoginSuccess={handleLoginSuccess} />
  }

  return (
    <AuthProvider authenticatedApi={authenticatedApi!} onLogout={logout}>
      {children}
    </AuthProvider>
  )
}