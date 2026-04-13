import { createContext, useContext, ReactNode } from 'react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'

interface AuthContextType {
  authenticatedApi: RpcStub<AuthenticatedApi>
  logout: () => void
}

const AuthContext = createContext<AuthContextType | null>(null)

interface AuthProviderProps {
  children: ReactNode
  authenticatedApi: RpcStub<AuthenticatedApi>
  onLogout: () => void
}

export function AuthProvider({ children, authenticatedApi, onLogout }: AuthProviderProps) {
  return (
    <AuthContext.Provider value={{ authenticatedApi, logout: onLogout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuthenticatedApi() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuthenticatedApi must be used within an AuthProvider')
  }
  return context
}

/** Returns the auth context when inside an AuthProvider, or null on public pages. */
export function useOptionalAuthenticatedApi(): AuthContextType | null {
  return useContext(AuthContext)
}