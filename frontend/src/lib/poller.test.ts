import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPoller, type PollerEnv } from './poller'

function makeEnv() {
  let hidden = false
  let visibilityListeners: Array<() => void> = []
  let activityListeners: Array<() => void> = []
  const env: PollerEnv = {
    isHidden: () => hidden,
    now: () => Date.now(),
    onVisibilityChange: (listener) => {
      visibilityListeners.push(listener)
      return () => {
        visibilityListeners = visibilityListeners.filter((l) => l !== listener)
      }
    },
    onActivity: (listener) => {
      activityListeners.push(listener)
      return () => {
        activityListeners = activityListeners.filter((l) => l !== listener)
      }
    },
  }
  return {
    env,
    setHidden(value: boolean) {
      hidden = value
      visibilityListeners.slice().forEach((l) => l())
    },
    activity() {
      activityListeners.slice().forEach((l) => l())
    },
    listenerCount: () => visibilityListeners.length + activityListeners.length,
  }
}

const OPTIONS = { intervalMs: 5000, idleMs: 600000 }

describe('createPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ticks immediately on start, then every intervalMs', async () => {
    const { env } = makeEnv()
    const tick = vi.fn().mockResolvedValue(true)
    createPoller(tick, OPTIONS, env).start()
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(tick).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it('does not tick while the tab is hidden, and ticks immediately when it becomes visible', async () => {
    const t = makeEnv()
    const tick = vi.fn().mockResolvedValue(true)
    createPoller(tick, OPTIONS, t.env).start()
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)

    t.setHidden(true)
    await vi.advanceTimersByTimeAsync(60000)
    expect(tick).toHaveBeenCalledTimes(1)

    t.setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(tick).toHaveBeenCalledTimes(3)
  })

  it('does not start ticking when started hidden until it becomes visible', async () => {
    const t = makeEnv()
    t.setHidden(true)
    const tick = vi.fn().mockResolvedValue(true)
    createPoller(tick, OPTIONS, t.env).start()
    await vi.advanceTimersByTimeAsync(30000)
    expect(tick).not.toHaveBeenCalled()
    t.setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('pauses after idleMs without activity, reports it, and resumes with an immediate tick on activity', async () => {
    const t = makeEnv()
    const tick = vi.fn().mockResolvedValue(true)
    const onPausedChange = vi.fn()
    createPoller(tick, { ...OPTIONS, onPausedChange }, t.env).start()

    await vi.advanceTimersByTimeAsync(700000)
    expect(onPausedChange).toHaveBeenLastCalledWith(true)
    const callsWhenPaused = tick.mock.calls.length

    await vi.advanceTimersByTimeAsync(60000)
    expect(tick.mock.calls.length).toBe(callsWhenPaused)

    t.activity()
    await vi.advanceTimersByTimeAsync(0)
    expect(onPausedChange).toHaveBeenLastCalledWith(false)
    expect(tick.mock.calls.length).toBe(callsWhenPaused + 1)
  })

  it('activity before the idle limit keeps polling alive', async () => {
    const t = makeEnv()
    const tick = vi.fn().mockResolvedValue(true)
    const onPausedChange = vi.fn()
    createPoller(tick, { ...OPTIONS, onPausedChange }, t.env).start()

    await vi.advanceTimersByTimeAsync(500000)
    t.activity()
    await vi.advanceTimersByTimeAsync(300000) // 800s total, only 300s since activity
    expect(onPausedChange).not.toHaveBeenCalledWith(true)
    const before = tick.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(tick.mock.calls.length).toBe(before + 1)
  })

  it('never overlaps ticks, even if visibility toggles while one is in flight', async () => {
    const t = makeEnv()
    let resolveFirst: (value: boolean) => void = () => {}
    const tick = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (resolveFirst = resolve)),
      )
      .mockResolvedValue(true)
    createPoller(tick, OPTIONS, t.env).start()
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1)

    t.setHidden(true)
    t.setHidden(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(tick).toHaveBeenCalledTimes(1) // still the in-flight one

    resolveFirst(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(tick).toHaveBeenCalledTimes(2)
  })

  it('stops permanently when tick resolves false', async () => {
    const t = makeEnv()
    const tick = vi.fn().mockResolvedValue(false)
    createPoller(tick, OPTIONS, t.env).start()
    await vi.advanceTimersByTimeAsync(60000)
    expect(tick).toHaveBeenCalledTimes(1)
    expect(t.listenerCount()).toBe(0)
  })

  it('treats a rejected tick as keep-polling', async () => {
    const t = makeEnv()
    const tick = vi
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue(true)
    createPoller(tick, OPTIONS, t.env).start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(tick).toHaveBeenCalledTimes(2)
  })

  it('stop() cancels the timer and unsubscribes', async () => {
    const t = makeEnv()
    const tick = vi.fn().mockResolvedValue(true)
    const poller = createPoller(tick, OPTIONS, t.env)
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    poller.stop()
    await vi.advanceTimersByTimeAsync(60000)
    expect(tick).toHaveBeenCalledTimes(1)
    expect(t.listenerCount()).toBe(0)
  })
})
