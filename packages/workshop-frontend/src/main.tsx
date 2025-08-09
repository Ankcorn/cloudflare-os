import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { RpcStub, newWebSocketRpcSession } from '@cloudflare/jsrpc'
import { PublicApi } from '@minions/workshop-shared/api'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'

function startConnection(url: string): RpcStub<PublicApi> {
  return newWebSocketRpcSession<PublicApi>(url);
}

// TODO: Figure out reconnect story.
const globalApi: RpcStub<PublicApi> = startConnection('ws://localhost:8787/api');

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#1976d2',
    },
    secondary: {
      main: '#dc004e',
    },
  },
  typography: {
    fontFamily: [
      '-apple-system',
      'BlinkMacSystemFont',
      '"Segoe UI"',
      'Roboto',
      '"Helvetica Neue"',
      'Arial',
      'sans-serif',
    ].join(','),
  },
});

const root = createRoot(document.getElementById('root')!)

root.render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App rpcStub={globalApi} />
    </ThemeProvider>
  </StrictMode>
)