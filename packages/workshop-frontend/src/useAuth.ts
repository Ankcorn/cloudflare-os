import { useState, useEffect } from 'react'
import { RpcStub } from '@cloudflare/jsrpc'
import { PublicApi, AuthenticatedApi } from '@minions/workshop-shared/api'

interface AuthState {
  token: string | null
  authenticatedApi: RpcStub<AuthenticatedApi> | null
  isLoading: boolean
  error: string | null
}

export function useAuth(publicApi: RpcStub<PublicApi>) {
  const [authState, setAuthState] = useState<AuthState>({
    token: null,
    authenticatedApi: null,
    isLoading: true,
    error: null
  })

  useEffect(() => {
    const storedToken = localStorage.getItem('authToken')
    if (storedToken) {
      authenticateWithToken(storedToken)
    } else {
      setAuthState(prev => ({ ...prev, isLoading: false }))
    }
  }, [])

  const authenticateWithToken = async (token: string) => {
    try {
      setAuthState(prev => ({ ...prev, isLoading: true, error: null }))
      const authenticatedApi = await publicApi.authenticate(token)
      setAuthState({
        token,
        authenticatedApi,
        isLoading: false,
        error: null
      })
    } catch (error) {
      localStorage.removeItem('authToken')
      setAuthState({
        token: null,
        authenticatedApi: null,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Authentication failed'
      })
    }
  }

  const login = (token: string) => {
    authenticateWithToken(token)
  }

  const logout = () => {
    localStorage.removeItem('authToken')
    setAuthState({
      token: null,
      authenticatedApi: null,
      isLoading: false,
      error: null
    })
  }

  return {
    ...authState,
    login,
    logout,
    isAuthenticated: !!authState.authenticatedApi
  }
}