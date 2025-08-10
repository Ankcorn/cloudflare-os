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

  const authenticateWithToken = (token: string) => {
    setAuthState(prev => ({ ...prev, isLoading: true, error: null }))
    // Use promise pipelining - we can use the returned promise as a stub immediately
    // without awaiting. Authentication errors will be handled when the stub is actually used.
    const authenticatedApi = publicApi.authenticate(token)
    setAuthState({
      token,
      authenticatedApi,
      isLoading: false,
      error: null
    })
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