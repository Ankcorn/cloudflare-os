import { Routes, Route, Navigate } from 'react-router-dom'
import { RpcStub } from 'capnweb'
import { PublicApi } from '@minions/workshop-shared/api'
import Home from './Home'
import MinionEditor from './MinionEditor'
import SettingsPage from './SettingsPage'
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

      <Route
        path="/settings"
        element={
          <ProtectedRoute rpcStub={rpcStub}>
            <SettingsPage />
          </ProtectedRoute>
        }
      />

      <Route
        path="/minion/:id"
        element={
          <ProtectedRoute rpcStub={rpcStub}>
            <MinionEditor />
          </ProtectedRoute>
        }
      />

      {/* Redirect any unmatched routes to home for now */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App