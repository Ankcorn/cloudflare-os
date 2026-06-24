import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { RpcStub, newWebSocketRpcSession } from 'capnweb'
import { PublicApi, ServerConfig } from '@gadgets/workshop-shared/api'
import { RpcContext } from './RpcContext'
import { ServerConfigContext } from './ServerConfigContext'
import { createRouter } from './router'
import './styles.css'

// ---------------------------------------------------------------------------
// Dev auto-login: if VITE_DEV_AUTO_LOGIN=true, automatically create/login
// with the dev account before React renders, so you never see the login page.
// ---------------------------------------------------------------------------
async function devAutoLogin(stub: RpcStub<PublicApi>): Promise<void> {
  if (import.meta.env.VITE_DEV_AUTO_LOGIN !== 'true') return
  if (localStorage.getItem('authToken')) return  // already logged in

  const username = import.meta.env.VITE_DEV_USERNAME ?? 'dev'
  const password = import.meta.env.VITE_DEV_PASSWORD ?? 'devpassword'

  // Derive the passwordHash the same way the app does (argon2id via hashPassword),
  // but here we use the same SERVICE_SALT + SHA-256 shortcut that wrangler dev accepts
  // in local mode. We import hashPassword from the existing util.
  const { hashPassword } = await import('./passwordHash')
  const passwordHash = await hashPassword(username, password)

  // Try createAccount first — works on a fresh backend. Returns null if already exists.
  let token = await stub.createAccount(username, username, passwordHash)

  // If null, account already exists — just log in.
  if (!token) {
    token = await stub.login(username, passwordHash)
  }

  if (token) {
    localStorage.setItem('authToken', token)
  }
}

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

function getBackendHost(): string {
  const backendHost = import.meta.env.VITE_BACKEND_HOST?.trim();
  if (backendHost) return backendHost;

  // When opening the Vite dev server directly (localhost:3000), the backend is at localhost:8787.
  // Otherwise, the API is on the same host as the frontend.
  return window.location.hostname === 'localhost' ? 'localhost:8787' : window.location.host;
}

function startConnection(): RpcStub<PublicApi> {
  lastConnectTime = Date.now();
  const apiHost = getBackendHost();
  const wsUrl = (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + apiHost + '/api';
  return newWebSocketRpcSession<PublicApi>(wsUrl);
}

async function handleBroken(error: any) {
  console.warn('RPC connection lost:', error);

  isConnectionLost = true;
  for (let cb of notifyCurrentStubUpdated) { cb(); }

  let timeSinceConnect = Date.now() - lastConnectTime;
  if (timeSinceConnect < backoff) {
    let waitTime = backoff - timeSinceConnect;
    console.warn(`Will try again in ${Math.round(waitTime / 1000)} seconds...`)
    await new Promise(resolve => setTimeout(resolve, waitTime));
    console.warn(`Retrying connection...`);
    backoff = Math.min(backoff * 2, 10000);
  } else {
    backoff = 1000;
  }

  currentStub = startConnection();
  currentStub.onRpcBroken(handleBroken);

  // Don't clear isConnectionLost here — the new connection hasn't proven
  // it works yet. It gets cleared by markConnectionRestored() once the
  // app successfully communicates with the backend.
  for (let cb of notifyCurrentStubUpdated) {
    cb();
  }
}

// Callbacks to call whenever `currentStub` or connection state is updated.
let notifyCurrentStubUpdated: Set<() => void> = new Set();
let isConnectionLost = false;

// Called externally (e.g., by auth) to indicate the connection is alive.
export function markConnectionRestored() {
  if (!isConnectionLost) return;
  isConnectionLost = false;
  for (let cb of notifyCurrentStubUpdated) { cb(); }
}

// Current stub. handleBroken() will replace this on disconnect.
let currentStub = startConnection();
currentStub.onRpcBroken(handleBroken);

const router = createRouter()

function AppWithConnection() {
  const [rpcState, setRpcState] = useState<{stub: RpcStub<PublicApi>; connectionLost: boolean}>({
    stub: currentStub,
    connectionLost: isConnectionLost,
  });
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);

  useEffect(() => {
    let cb = () => setRpcState({ stub: currentStub, connectionLost: isConnectionLost });
    notifyCurrentStubUpdated.add(cb);
    return () => { notifyCurrentStubUpdated.delete(cb); };
  }, []);

  // Fetch deployment config once the (re)connected stub is available. Re-fetch on reconnect so a
  // server restart with changed config is picked up.
  useEffect(() => {
    let cancelled = false;
    rpcState.stub.getServerConfig()
      .then((cfg) => { if (!cancelled) setServerConfig(cfg); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [rpcState.stub]);

  return (
    <RpcContext.Provider value={rpcState}>
      <ServerConfigContext.Provider value={serverConfig}>
        <RouterProvider router={router} />
      </ServerConfigContext.Provider>
    </RpcContext.Provider>
  );
}

const root = createRoot(document.getElementById('root')!)

// Kick off dev auto-login in the background. If it completes before
// useAuth checks the token, the user skips the login page. If the backend
// is unreachable, the app still renders immediately (showing a connection
// banner or login page) instead of hanging on a blank screen.
devAutoLogin(currentStub).catch(() => {})

root.render(
  <StrictMode>
    <AppWithConnection />
  </StrictMode>
)
