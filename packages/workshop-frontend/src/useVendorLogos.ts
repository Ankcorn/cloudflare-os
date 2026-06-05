import { useEffect, useState } from 'react'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'

// Shared per-session cache so every consumer reuses a single fetch.
const cachedPromises = new WeakMap<RpcStub<AuthenticatedApi>, Promise<Map<string, string>>>()

const EMPTY: Map<string, string> = new Map()

// Maps each vendor id to its logo URL so connection rows can show the service's icon.
export function useVendorLogos(
  authenticatedApi: RpcStub<AuthenticatedApi> | null,
  { enabled = true }: { enabled?: boolean } = {},
): Map<string, string> {
  const [logos, setLogos] = useState<Map<string, string>>(EMPTY)

  useEffect(() => {
    if (!authenticatedApi || !enabled) return
    let cancelled = false

    let promise = cachedPromises.get(authenticatedApi)
    if (!promise) {
      const api = authenticatedApi
      promise = (async () => {
        const vendors = await api.listGatekeeperVendors()
        const map = new Map<string, string>()
        for (const vendor of vendors) {
          if (vendor.description.logo?.url) {
            map.set(vendor.id, vendor.description.logo.url)
          }
        }
        return map
      })().catch((err) => {
        cachedPromises.delete(api)
        throw err
      })
      cachedPromises.set(api, promise)
    }

    promise
      .then((map) => { if (!cancelled) setLogos(map) })
      .catch((err) => {
        console.error('Failed to load vendor logos:', err)
      })

    return () => { cancelled = true }
  }, [authenticatedApi, enabled])

  return logos
}
