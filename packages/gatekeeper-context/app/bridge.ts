import { createContext, useContext } from 'react'
import type { RpcStub } from 'capnweb'
import type { ContextApi } from '../src/context-types'

// React context carrying the host-injected ContextApi capability (the gatekeeper's `ui` stub).
const ContextApiContext = createContext<RpcStub<ContextApi> | null>(null)

export const ContextApiProvider = ContextApiContext.Provider

export function useContextApi(): RpcStub<ContextApi> {
  const api = useContext(ContextApiContext)
  if (!api) throw new Error('useContextApi() used outside ContextApiProvider')
  return api
}
