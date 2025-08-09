import { useState, useEffect } from 'react'
import { RpcStub } from '@cloudflare/jsrpc'
import { PublicApi } from '@minions/workshop-shared/api'

interface AppProps {
  rpcStub: RpcStub<PublicApi>
}

function App({ rpcStub }: AppProps) {
  const [greetResult, setGreetResult] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const callGreet = async () => {
      try {
        setLoading(true)
        const result = await rpcStub.greet('World')
        setGreetResult(result)
        setError(null)
      } catch (err) {
        console.error('Failed to call greet:', err)
        setError(err instanceof Error ? err.message : 'Unknown error')
        setGreetResult(null)
      } finally {
        setLoading(false)
      }
    }

    callGreet()
  }, [rpcStub])

  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <h1>Workshop Frontend</h1>
      
      <div style={{ marginTop: '20px' }}>
        <h2>RPC Test</h2>
        {loading && <p>Calling greet() method...</p>}
        {error && <p style={{ color: 'red' }}>Error: {error}</p>}
        {greetResult && <p style={{ color: 'green' }}>Server response: {greetResult}</p>}
      </div>
    </div>
  )
}

export default App