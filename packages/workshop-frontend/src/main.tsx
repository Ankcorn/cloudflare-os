import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { RpcStub, newWebSocketRpcSession } from '@cloudflare/jsrpc'
import { PublicApi } from '@minions/workshop-shared/api'
import { BrowserRouter } from 'react-router-dom'
import '@ant-design/v5-patch-for-react-19'
import 'antd/dist/reset.css'

function startConnection(url: string): RpcStub<PublicApi> {
  return newWebSocketRpcSession<PublicApi>(url);
}

// TODO: Figure out reconnect story.
const globalApi: RpcStub<PublicApi> = startConnection('ws://localhost:8787/api');

const root = createRoot(document.getElementById('root')!)

root.render(
  <StrictMode>
    <BrowserRouter>
      <App rpcStub={globalApi} />
    </BrowserRouter>
  </StrictMode>
)