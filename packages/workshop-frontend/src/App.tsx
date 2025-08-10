import { Routes, Route, Navigate } from 'react-router-dom'
import { RpcStub } from '@cloudflare/jsrpc'
import { PublicApi } from '@minions/workshop-shared/api'
import Home from './Home'
import ProtectedRoute from './ProtectedRoute'

interface AppProps {
  rpcStub: RpcStub<PublicApi>
}

function App({ rpcStub }: AppProps) {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <ProtectedRoute rpcStub={rpcStub}>
            <Home />
          </ProtectedRoute>
        }
      />
      
      {/* Redirect any unmatched routes to home for now */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App