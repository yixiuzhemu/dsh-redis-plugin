import { beforeEach, describe, expect, it } from 'vitest'
import { createRedis } from '../src/service.js'
import type { RedisService } from '../src/service.js'
import type { ClientCtor } from '../src/connection/factory.js'
import { UNLOCK_SCRIPT, RENEW_SCRIPT } from '../src/lock/scripts.js'

/**
 * A tiny in-memory Redis stand-in. ioredis-mock's Lua/eval support is
 * unreliable, and the lock's correctness lives entirely in the token-guarded
 * scripts, so we hand-roll just enough surface: SET NX PX, GET, EVAL, PING,
 * QUIT. All instances share one backing store to model a single server.
 */
const store = new Map<string, { value: string; expiresAt: number | null }>()

function now(): number {
  return Date.now()
}

function liveGet(key: string): string | null {
  const rec = store.get(key)
  if (!rec) return null
  if (rec.expiresAt !== null && rec.expiresAt <= now()) {
    store.delete(key)
    return null
  }
  return rec.value
}

class FakeRedis {
  // ioredis-compatible no-op surface used by the pool.
  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    let nx = false
    let px: number | null = null
    for (let i = 0; i < args.length; i++) {
      const a = String(args[i]).toUpperCase()
      if (a === 'NX') nx = true
      else if (a === 'PX') px = Number(args[++i])
      else if (a === 'EX') px = Number(args[++i]) * 1000
    }
    if (nx && liveGet(key) !== null) return null
    store.set(key, { value: String(value), expiresAt: px === null ? null : now() + px })
    return 'OK'
  }

  async get(key: string): Promise<string | null> {
    return liveGet(key)
  }

  async eval(script: string, numKeys: number, ...rest: unknown[]): Promise<number> {
    const keys = rest.slice(0, numKeys).map(String)
    const argv = rest.slice(numKeys).map(String)
    const key = keys[0]!
    const token = argv[0]!
    if (script === UNLOCK_SCRIPT) {
      if (liveGet(key) === token) {
        store.delete(key)
        return 1
      }
      return 0
    }
    if (script === RENEW_SCRIPT) {
      if (liveGet(key) === token) {
        const rec = store.get(key)!
        rec.expiresAt = now() + Number(argv[1])
        return 1
      }
      return 0
    }
    throw new Error(`FakeRedis: unsupported script: ${script.slice(0, 40)}`)
  }

  async ping(): Promise<'PONG'> {
    return 'PONG'
  }

  async quit(): Promise<'OK'> {
    return 'OK'
  }

  disconnect(): void {
    /* no-op */
  }
}

const FakeCtor = FakeRedis as unknown as ClientCtor

function makeService(): RedisService {
  return createRedis(
    {
      pool: { min: 1, max: 1, healthCheckMs: 0 },
      executor: { coreSize: 2, maxSize: 2, retry: { maxAttempts: 1, backoffMs: 1 } },
      lock: { defaultTtlMs: 30_000, watchdogIntervalMs: 1000, renewAheadMs: 10_000, releaseOnDispose: false },
    },
    { clientCtor: FakeCtor },
  )
}

describe('RedisLock', () => {
  let redis: RedisService

  beforeEach(async () => {
    store.clear()
    redis = makeService()
    await redis.start()
  })

  it('acquires a lock and returns a tracked token', async () => {
    const token = await redis.lock.tryLock('order:1', 5, 's')
    expect(token).not.toBeNull()
    expect(token!.ttlMs).toBe(5000)
    expect(redis.lock.heldCount).toBe(1)
    // The raw key holds exactly the token value.
    expect(store.get('order:1')?.value).toBe(token!.value)
    await redis.dispose()
  })

  it('is mutually exclusive: a second holder cannot acquire', async () => {
    const first = await redis.lock.tryLock('mutex')
    expect(first).not.toBeNull()
    const second = await redis.lock.tryLock('mutex')
    expect(second).toBeNull()
    await redis.dispose()
  })

  it('unlock is token-guarded (a foreign token cannot release)', async () => {
    const token = await redis.lock.tryLock('guarded')
    expect(token).not.toBeNull()

    const foreign = { key: 'guarded', value: 'not-mine', ttlMs: 1000, acquiredAt: now() }
    const releasedByForeign = await redis.lock.unlock('guarded', foreign)
    expect(releasedByForeign).toBe(false)
    // Lock still present and still owned by the real token.
    expect(store.get('guarded')?.value).toBe(token!.value)

    const releasedByOwner = await redis.lock.unlock('guarded', token!)
    expect(releasedByOwner).toBe(true)
    expect(store.has('guarded')).toBe(false)
    await redis.dispose()
  })

  it('withLock runs the critical section then releases in finally', async () => {
    let ran = false
    const result = await redis.lock.withLock('section', async () => {
      ran = true
      expect(store.has('section')).toBe(true)
      return 42
    })
    expect(result).toBe(42)
    expect(ran).toBe(true)
    expect(store.has('section')).toBe(false)
    expect(redis.lock.heldCount).toBe(0)
    await redis.dispose()
  })

  it('withLock releases even when the critical section throws', async () => {
    await expect(
      redis.lock.withLock('boom', async () => {
        throw new Error('critical failure')
      }),
    ).rejects.toThrow('critical failure')
    expect(store.has('boom')).toBe(false)
    expect(redis.lock.heldCount).toBe(0)
    await redis.dispose()
  })

  it('withLock throws when the lock is already held', async () => {
    const held = await redis.lock.tryLock('contended')
    expect(held).not.toBeNull()
    await expect(redis.lock.withLock('contended', async () => 'nope')).rejects.toThrow(/acquire lock/)
    await redis.dispose()
  })

  it('renew extends the TTL only for the owner', async () => {
    const token = await redis.lock.tryLock('renewable', 1000)
    expect(token).not.toBeNull()
    const ok = await redis.lock.renew('renewable', token!, 60_000)
    expect(ok).toBe(true)
    expect(store.get('renewable')!.expiresAt!).toBeGreaterThan(now() + 30_000)

    const foreign = { key: 'renewable', value: 'other', ttlMs: 1000, acquiredAt: now() }
    expect(await redis.lock.renew('renewable', foreign, 60_000)).toBe(false)
    await redis.dispose()
  })

  it('isHeldByMe reflects real ownership', async () => {
    const token = await redis.lock.tryLock('mine')
    expect(await redis.lock.isHeldByMe('mine', token!)).toBe(true)
    await redis.lock.unlock('mine', token!)
    expect(await redis.lock.isHeldByMe('mine', token!)).toBe(false)
    await redis.dispose()
  })

  it('tryLockWithRetry keeps polling until the holder releases', async () => {
    const holder = await redis.lock.tryLock('retry-me', 5000)
    expect(holder).not.toBeNull()

    const pending = redis.lock.tryLockWithRetry('retry-me', 5000, 10, 100)
    // Release shortly after so a later retry succeeds.
    setTimeout(() => void redis.lock.unlock('retry-me', holder!), 35)
    const token = await pending
    expect(token).not.toBeNull()
    expect(token!.value).not.toBe(holder!.value)
    await redis.dispose()
  })

  it('the watchdog renews a held lock across ticks', async () => {
    // Short TTL + aggressive renew-ahead so a tick renews immediately.
    const token = await redis.lock.tryLock('watched', 200)
    expect(token).not.toBeNull()
    redis.lock.registry.get(token!.value)!.nextRenewAt = 0
    redis.lock.startWatchdog()
    await new Promise((r) => setTimeout(r, 60))
    // Still owned and its expiry was pushed out by the renewal.
    expect(store.get('watched')?.value).toBe(token!.value)
    expect(store.get('watched')!.expiresAt!).toBeGreaterThan(now())
    redis.lock.stopWatchdog()
    await redis.dispose()
  })

  it('dispose relies on TTL by default (does not delete live locks)', async () => {
    const token = await redis.lock.tryLock('persist-on-dispose', 30_000)
    expect(token).not.toBeNull()
    await redis.dispose()
    // releaseOnDispose=false → the key survives so the critical section is safe.
    expect(store.has('persist-on-dispose')).toBe(true)
  })

  it('dispose actively releases when releaseOnDispose is set', async () => {
    const svc = createRedis(
      {
        pool: { min: 1, max: 1, healthCheckMs: 0 },
        executor: { retry: { maxAttempts: 1, backoffMs: 1 } },
        lock: { releaseOnDispose: true },
      },
      { clientCtor: FakeCtor },
    )
    await svc.start()
    const token = await svc.lock.tryLock('release-on-dispose', 30_000)
    expect(token).not.toBeNull()
    await svc.dispose()
    expect(store.has('release-on-dispose')).toBe(false)
  })
})
