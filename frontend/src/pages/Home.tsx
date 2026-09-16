import { useNavigate } from 'react-router-dom'
import { createListener } from '../api'

export function Home() {
  const navigate = useNavigate()

  async function handleCreate() {
    const listener = await createListener()
    navigate(`/listener/${listener.id}`)
  }

  return (
    <main>
      <h1>Webhook Listener</h1>
      <button onClick={handleCreate}>Create new webhook listener</button>
    </main>
  )
}
