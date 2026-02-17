import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { RpcStub, newWebSocketRpcSession } from 'capnweb'
import { PublicApi } from '@gadgets/workshop-shared/api'
import { BrowserRouter } from 'react-router-dom'
import '@ant-design/v5-patch-for-react-19'
import 'antd/dist/reset.css'

// WebSocket RPC connection management.
//
// React's useEffect / useState machinery is kind of obnoxious in that, in dev mode, it runs
// everything twice (runs once, immediately cleans up, then runs again). This isn't so good for
// our WebSocket as it means we are creating redundant connections to the server and throwing
// them away instantly. It gets even worse when we start trying to handle disconnects gracefully:
// we can end up with two connections that are fighting to replace each other.
//
// Or maybe I (Kenton) was just holding it wrong, idk.
//
// Anyway, I pulled the connection management out into these globals instead.
let lastConnectTime: number = 0;
let backoff: number = 1000;

function startConnection(): RpcStub<PublicApi> {
  lastConnectTime = Date.now();
  // When opening the Vite dev server directly (localhost:3000), the backend is at localhost:8787.
  // Otherwise, the API is on the same host as the frontend.
  const apiHost = window.location.host === 'localhost:3000' ? 'localhost:8787' : window.location.host;
  const wsUrl = (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + apiHost + '/api';
  return newWebSocketRpcSession<PublicApi>(wsUrl);
}
async function handleBroken(error: any) {
  console.warn('RPC connection lost:', error);

  let timeSinceConnect = Date.now() - lastConnectTime;
  if (timeSinceConnect < backoff) {
    // Reconnecting too quickly, wait a bit.
    let waitTime = backoff - timeSinceConnect;
    console.warn(`Will try again in ${Math.round(waitTime / 1000)} seconds...`)
    await new Promise(resolve => setTimeout(resolve, waitTime));
    console.warn(`Retrying connection...`);

    // Wait twice as long next time, but no more than 10 seconds.
    backoff = Math.min(backoff * 2, 10000);
  } else {
    // Reconnect immediately and reset backoff for next time.
    backoff = 1000;
  }

  currentStub = startConnection();
  currentStub.onRpcBroken(handleBroken);

  for (let cb of notifyCurrentStubUpdated) {
    cb();
  }
}

// Callbacks to call whenever `currentStub` is updated.
let notifyCurrentStubUpdated: Set<() => void> = new Set();

// Current stub. handleBroken() will replace this on disconnect.
let currentStub = startConnection();
currentStub.onRpcBroken(handleBroken);

function AppWithConnection() {
  const [rpcStub, setRpcStub] = useState<{stub: RpcStub<PublicApi>}>({stub: currentStub});

  useEffect(() => {
    let cb = () => setRpcStub({stub: currentStub});
    notifyCurrentStubUpdated.add(cb);
    return () => { notifyCurrentStubUpdated.delete(cb); };
  }, []);

  return (
    <BrowserRouter>
      <App rpcStub={rpcStub.stub} />
    </BrowserRouter>
  );
}

const root = createRoot(document.getElementById('root')!)

root.render(
  <StrictMode>
    <AppWithConnection />
  </StrictMode>
)