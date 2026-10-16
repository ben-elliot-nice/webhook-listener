export interface PollerEnv {
  isHidden: () => boolean
  now: () => number
  onVisibilityChange: (listener: () => void) => () => void
  onActivity: (listener: () => void) => () => void
}

export interface PollerOptions {
  // null: run once on start and on each return to a visible tab; never on a timer.
  intervalMs: number | null
  idleMs: number
  onPausedChange?: (paused: boolean) => void
}

export interface Poller {
  start: () => void
  stop: () => void
}

// Framework-free so it can be unit tested with fake timers. `tick` resolves
// true to keep polling, false to stop for good; a rejection keeps polling.
// Polling is paused while the tab is hidden, and after `idleMs` without user
// activity (resumed, with an immediate tick, on the next activity).
export function createPoller(
  tick: () => Promise<boolean>,
  options: PollerOptions,
  env: PollerEnv,
): Poller {
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let stopped = true
  let idlePaused = false
  let lastActivity = 0
  let unsubscribers: Array<() => void> = []

  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  function setPaused(next: boolean) {
    if (idlePaused === next) return
    idlePaused = next
    options.onPausedChange?.(next)
  }

  function schedule() {
    clearTimer()
    const interval = options.intervalMs
    if (stopped || interval === null || env.isHidden()) return
    if (env.now() - lastActivity >= options.idleMs) {
      setPaused(true)
      return
    }
    timer = setTimeout(run, interval)
  }

  async function run() {
    timer = undefined
    if (stopped || inFlight) return
    inFlight = true
    let keepGoing = true
    try {
      keepGoing = await tick()
    } catch {
      keepGoing = true
    }
    inFlight = false
    if (stopped) return
    if (!keepGoing) {
      stop()
      return
    }
    schedule()
  }

  function handleVisibility() {
    if (stopped) return
    if (env.isHidden()) {
      clearTimer()
      return
    }
    lastActivity = env.now()
    setPaused(false)
    if (timer === undefined && !inFlight) void run()
  }

  function handleActivity() {
    if (stopped) return
    lastActivity = env.now()
    if (idlePaused) {
      setPaused(false)
      if (!inFlight) void run()
    }
  }

  function start() {
    if (!stopped) return
    stopped = false
    lastActivity = env.now()
    unsubscribers = [
      env.onVisibilityChange(handleVisibility),
      env.onActivity(handleActivity),
    ]
    if (!env.isHidden()) void run()
  }

  function stop() {
    stopped = true
    clearTimer()
    unsubscribers.forEach((unsubscribe) => unsubscribe())
    unsubscribers = []
  }

  return { start, stop }
}

const ACTIVITY_EVENTS = [
  'pointerdown',
  'pointermove',
  'keydown',
  'scroll',
  'touchstart',
  'wheel',
] as const

// The activity handler is a single timestamp assignment on the hot path, so
// no throttling is needed.
export const browserPollerEnv: PollerEnv = {
  isHidden: () => document.hidden,
  now: () => Date.now(),
  onVisibilityChange: (listener) => {
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
  onActivity: (listener) => {
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, listener, { passive: true, capture: true })
    }
    return () => {
      for (const name of ACTIVITY_EVENTS) {
        window.removeEventListener(name, listener, { capture: true })
      }
    }
  },
}
