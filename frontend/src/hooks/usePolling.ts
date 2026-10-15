import { useEffect, useState } from 'react'
import { browserPollerEnv, createPoller } from '../lib/poller'

export const POLL_INTERVAL_MS = 5000
export const POLL_IDLE_MS = 10 * 60 * 1000

// Polls `tick` immediately and then every POLL_INTERVAL_MS while the tab is
// visible and the user has been active in the last POLL_IDLE_MS. `tick`
// resolving false stops polling for good. Restarts when `tick`'s identity
// changes (pass a useCallback'd function).
export function usePolling(tick: () => Promise<boolean>): { paused: boolean } {
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    setPaused(false)
    const poller = createPoller(
      tick,
      {
        intervalMs: POLL_INTERVAL_MS,
        idleMs: POLL_IDLE_MS,
        onPausedChange: setPaused,
      },
      browserPollerEnv,
    )
    poller.start()
    return poller.stop
  }, [tick])

  return { paused }
}
