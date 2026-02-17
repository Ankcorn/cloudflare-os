import { Routes, Route, Navigate } from 'react-router-dom'
import { RpcStub } from 'capnweb'
import { PublicApi } from '@gadgets/workshop-shared/api'
import Home from './Home'
import GadgetEditor from './GadgetEditor'
import SettingsPage from './SettingsPage'
import ProtectedRoute from './ProtectedRoute'
import SignupPage from './SignupPage'
import { CF_ACCESS_MODE } from './useAuth'

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

      <Route
        path="/settings"
        element={
          <ProtectedRoute rpcStub={rpcStub}>
            <SettingsPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/gadget/:id"
        element={
          <ProtectedRoute rpcStub={rpcStub}>
            <GadgetEditor />
          </ProtectedRoute>
        }
      />

      {/* Signup is not available in CF Access mode — identity is managed by Access. */}
      <Route
        path="/signup"
        element={CF_ACCESS_MODE ? <Navigate to="/" replace /> : <SignupPage rpcStub={rpcStub} />}
      />

      {/* Redirect any unmatched routes to home for now */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App