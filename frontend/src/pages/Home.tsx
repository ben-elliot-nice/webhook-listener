import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createListener } from '../api'

export function Home() {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  async function handleCreate() {
    try {
      const listener = await createListener()
      navigate(`/listener/${listener.id}`)
    } catch {
      setError('Failed to create listener. Is the backend running?')
    }
  }

  return (
    <main>
      <h1>Webhook Listener</h1>
      <button onClick={handleCreate}>Create new webhook listener</button>
      {error && <p role="alert">{error}</p>}
    </main>
  )
}
