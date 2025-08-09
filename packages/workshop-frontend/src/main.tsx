import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { RpcStub, newWebSocketRpcSession } from '@cloudflare/jsrpc'
import { PublicApi } from '@minions/workshop-shared/api'

function startConnection(url: string): RpcStub<PublicApi> {
  return newWebSocketRpcSession<PublicApi>(url);
}

// TODO: Figure out reconnect story.
const globalApi: RpcStub<PublicApi> = startConnection('ws://localhost:8787/api');

const root = createRoot(document.getElementById('root')!)

root.render(
  <StrictMode>
    <App rpcStub={globalApi} />
  </StrictMode>
)