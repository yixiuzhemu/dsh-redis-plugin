import { describe, expect, it, vi } from 'vitest'
import { LockRegistry, type LockEntry } from '../src/lock/registry.js'
import { WatchdogScheduler } from '../src/lock/watchdog.js'
import type { LockToken } from '../src/types.js'

function makeEntry(key: string, over: Partial<LockEntry> = {}): LockEntry {
  const token: LockToken = { key, value: `token-${key}`, ttlMs: 30_000, acquiredAt: 0 }
  return {
    key,
    encodedKey: key,
    token,
    ttlMs: 30_000,
    // Due immediately so a tick will consider it.
    nextRenewAt: 0,
    ...over,
  }
}

describe('WatchdogScheduler', () => {
  it('renews a due lock and pushes the next renewal window out', async () => {
    const registry = new LockRegistry()
    const entry = makeEntry('lock:a', { nextRenewAt: 100, ttlMs: 30_000 })
    registry.add(entry)

    const renew = vi.fn(async () => true)
    const wd = new WatchdogScheduler({
      registry,
      intervalMs: 1000,
      renewAheadMs: 10_000,
      renew,
    })

    // now (500) >= nextRenewAt (100) → due.
    await wd.tick(500)

    expect(renew).toHaveBeenCalledTimes(1)
    expect(registry.size).toBe(1)
    // nextRenewAt = Date.now() + max(0, ttl - renewAhead) → strictly in the future.
    expect(entry.nextRenewAt).toBeGreaterThan(Date.now())
  })

  it('skips locks that are not due yet', async () => {
    const registry = new LockRegistry()
    registry.add(makeEntry('lock:future', { nextRenewAt: Date.now() + 60_000 }))

    const renew = vi.fn(async () => true)
    const wd = new WatchdogScheduler({ registry, intervalMs: 1000, renewAheadMs: 0, renew })

    await wd.tick()
    expect(renew).not.toHaveBeenCalled()
    expect(registry.size).toBe(1)
  })

  it('removes the lock and fires onLost when renewal reports it lost', async () => {
    const registry = new LockRegistry()
    const onLost = vi.fn()
    const entry = makeEntry('lock:lost', { nextRenewAt: 0, onLost })
    registry.add(entry)

    const wd = new WatchdogScheduler({
      registry,
      intervalMs: 1000,
      renewAheadMs: 0,
      renew: async () => false,
    })

    await wd.tick(1000)

    expect(registry.size).toBe(0)
    expect(onLost).toHaveBeenCalledWith('lock:lost')
  })

  it('treats a renew error as lost but keeps the loop alive', async () => {
    const registry = new LockRegistry()
    const onLost = vi.fn()
    registry.add(makeEntry('lock:err', { onLost }))

    const wd = new WatchdogScheduler({
      registry,
      intervalMs: 1000,
      renewAheadMs: 0,
      renew: async () => {
        throw new Error('Connection is closed')
      },
    })

    await wd.tick(1000)
    expect(registry.size).toBe(0)
    expect(onLost).toHaveBeenCalledOnce()
  })

  it('does not let a throwing onLost break the pass over other locks', async () => {
    const registry = new LockRegistry()
    const good = makeEntry('lock:good')
    registry.add(makeEntry('lock:bad', { onLost: () => { throw new Error('boom') } }))
    registry.add(good)

    const wd = new WatchdogScheduler({
      registry,
      intervalMs: 1000,
      renewAheadMs: 0,
      renew: async (e) => e.key === 'lock:good',
    })

    await wd.tick(1000)
    // lock:bad removed (lost), lock:good renewed and retained.
    expect(registry.get(good.token.value)).toBeDefined()
    expect(registry.size).toBe(1)
  })

  it('start() returns a disposer that stops the timer', () => {
    const registry = new LockRegistry()
    const wd = new WatchdogScheduler({
      registry,
      intervalMs: 50,
      renewAheadMs: 0,
      renew: async () => true,
    })

    const dispose = wd.start()
    expect(typeof dispose).toBe('function')
    // Idempotent: starting again returns a disposer without spawning a 2nd timer.
    const dispose2 = wd.start()
    expect(typeof dispose2).toBe('function')
    dispose()
    dispose2()
    // Stop on an already-stopped scheduler is a no-op.
    wd.stop()
  })
})
