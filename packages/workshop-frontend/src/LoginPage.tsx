import { useState } from 'react'
import { RpcStub } from '@cloudflare/jsrpc'
import { PublicApi } from '@minions/workshop-shared/api'
import {
  Box,
  Card,
  CardContent,
  TextField,
  Button,
  Typography,
  Alert,
  Container
} from '@mui/material'
import { LoadingButton } from '@mui/lab'

interface LoginPageProps {
  rpcStub: RpcStub<PublicApi>
  onLoginSuccess?: () => void
}

export default function LoginPage({ rpcStub, onLoginSuccess }: LoginPageProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    try {
      const token = await rpcStub.login(username, password)
      if (token) {
        localStorage.setItem('authToken', token)
        // Trigger re-authentication check in parent
        if (onLoginSuccess) {
          onLoginSuccess()
        } else {
          window.location.reload()
        }
      } else {
        setError('Invalid username or password')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#f5f5f5',
      }}
    >
      <Container maxWidth="sm">
        <Card
          sx={{
            maxWidth: 400,
            mx: 'auto',
            boxShadow: 2,
          }}
        >
          <CardContent sx={{ p: 4 }}>
            <Box sx={{ textAlign: 'center', mb: 4 }}>
              <Typography variant="h4" component="h1" gutterBottom fontWeight="bold">
                Minions Workshop
              </Typography>
              <Typography variant="body1" color="text.secondary">
                Sign in to your account
              </Typography>
            </Box>

            <Box component="form" onSubmit={handleSubmit} sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <TextField
                label="Username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                disabled={loading}
                autoFocus
                fullWidth
                variant="outlined"
              />

              <TextField
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={loading}
                fullWidth
                variant="outlined"
              />

              {error && (
                <Alert severity="error" sx={{ mb: 1 }}>
                  {error}
                </Alert>
              )}

              <LoadingButton
                type="submit"
                loading={loading}
                loadingIndicator="Signing in..."
                variant="contained"
                size="large"
                fullWidth
                sx={{
                  mt: 1,
                  py: 1.5,
                }}
              >
                {loading ? 'Signing in...' : 'Sign in'}
              </LoadingButton>
            </Box>
          </CardContent>
        </Card>
      </Container>
    </Box>
  )
}