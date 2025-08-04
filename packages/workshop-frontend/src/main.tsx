import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { RpcSession, RpcStub, WebSocketTransport } from 'jsrpc'
import { PublicApi } from '@minions/workshop-shared/api'

function startConnection(url: string): RpcStub<PublicApi> {
  const ws = new WebSocket(url);
  let transport = new WebSocketTransport(ws);
  let rpc = new RpcSession<PublicApi>(transport);
  return rpc.getRemoteMain();
}

// TODO: Figure out reconnect story.
const globalApi: RpcStub<PublicApi> = startConnection('ws://localhost:8787/api');

const root = createRoot(document.getElementById('root')!)

root.render(
  <StrictMode>
    <App rpcStub={globalApi} />
  </StrictMode>
)