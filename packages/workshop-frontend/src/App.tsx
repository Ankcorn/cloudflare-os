import { RpcStub } from '@cloudflare/jsrpc'
import { PublicApi } from '@minions/workshop-shared/api'
import { useAuth } from './useAuth'
import LoginPage from './LoginPage'
import Home from './Home'

interface AppProps {
  rpcStub: RpcStub<PublicApi>
}

function App({ rpcStub }: AppProps) {
  const { isAuthenticated, authenticatedApi, isLoading, error, login, logout } = useAuth(rpcStub)

  if (isLoading) {
    return (
      <div style={{ 
        minHeight: '100vh', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        fontFamily: 'Arial, sans-serif'
      }}>
        <p>Loading...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ 
        minHeight: '100vh', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        fontFamily: 'Arial, sans-serif'
      }}>
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: 'red' }}>Authentication error: {error}</p>
          <button onClick={() => window.location.reload()}>Retry</button>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <LoginPage rpcStub={rpcStub} onLogin={login} />
  }

  return <Home authenticatedApi={authenticatedApi!} onLogout={logout} />
}

export default App