import { useEffect, useState } from 'react'
import { browserPollerEnv, createPoller } from '../lib/poller'

export const POLL_INTERVAL_MS = 5000
export const POLL_IDLE_MS = 10 * 60 * 1000

// Polls `tick` immediately and then every `options.intervalMs` (default POLL_INTERVAL_MS; null = never on a timer, only on mount and
// each return to a visible tab) while the tab is
// visible and the user has been active in the last POLL_IDLE_MS. `tick`
// resolving false stops polling for good. Restarts when `tick`'s identity
// changes (pass a useCallback'd function).
export function usePolling(
  tick: () => Promise<boolean>,
  options?: { intervalMs?: number | null },
): { paused: boolean } {
  const [paused, setPaused] = useState(false)
  // null = no timer polling (run on mount and when the tab becomes visible).
  const intervalMs =
    options?.intervalMs === undefined ? POLL_INTERVAL_MS : options.intervalMs

  useEffect(() => {
    setPaused(false)
    const poller = createPoller(
      tick,
      { intervalMs, idleMs: POLL_IDLE_MS, onPausedChange: setPaused },
      browserPollerEnv,
    )
    poller.start()
    return poller.stop
  }, [tick, intervalMs])

  return { paused }
}
