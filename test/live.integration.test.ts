import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRedis } from '../src/service.js'
import type { RedisService } from '../src/service.js'

/**
 * LIVE integration test against a REAL Redis server.
 *
 * This is gated behind env vars so the default offline suite (ioredis-mock /
 * FakeRedis) never touches the network:
 *
 *   REDIS_LIVE=1 REDIS_LIVE_HOST=... REDIS_LIVE_PORT=... REDIS_LIVE_PASSWORD=...
 *
 * It exercises the same operation families as the offline tests but over a real
 * TCP connection, verifying wire-level behaviour (Lua lock scripts, MULTI/EXEC,
 * SCAN cursors, TTL, typeHint Date round-trip, etc.).
 */
const HOST = process.env.REDIS_LIVE_HOST
const PORT = Number(process.env.REDIS_LIVE_PORT ?? 6379)
const PASSWORD = process.env.REDIS_LIVE_PASSWORD
const ENABLED = process.env.REDIS_LIVE === '1' && Boolean(HOST)
const PREFIX = 'dsh:verify:'

// ioredis emits async 'error' events (e.g. on a bad handshake). Keep them from
// crashing the Vitest worker; individual assertions still surface real failures.
if (ENABLED) {
  process.on('uncaughtException', () => void 0)
}

describe.skipIf(!ENABLED)('live integration (real Redis)', () => {
  let redis: RedisService

  beforeAll(async () => {
    redis = createRedis({
      connection: {
        topology: 'standalone',
        host: HOST,
        port: PORT,
        password: PASSWORD || undefined,
        db: 0,
      },
      pool: { min: 2, max: 8, healthCheckMs: 0 },
      executor: { coreSize: 8, maxSize: 16, timeoutMs: 5000, retry: { maxAttempts: 1, backoffMs: 50 } },
      codec: { keyPrefix: PREFIX, value: 'json', typeHint: true },
      lock: { defaultTtlMs: 15_000, watchdogIntervalMs: 500, renewAheadMs: 5000, releaseOnDispose: true },
    })
    await redis.start()
    // Connectivity probe — fails fast with a clear error if the endpoint is not
    // a Redis server (e.g. a MySQL port would never complete the RESP handshake).
    await redis.set('__probe__', 'ok')
    expect(await redis.get('__probe__')).toBe('ok')
    await redis.del('__probe__')
  }, 20_000)

  afterAll(async () => {
    if (!redis) return
    const leftover = await redis.scanKeys({ match: '*' }).catch(() => [] as string[])
    if (leftover.length) await redis.del(leftover).catch(() => 0)
    await redis.dispose().catch(() => void 0)
  }, 20_000)

  it('string: set/get (typeHint Date), setEx+ttl, NX, counters, mset/mget', async () => {
    const val = { id: 1, when: new Date('2026-09-23T00:00:00.000Z'), tags: ['a', 'b'] }
    await redis.set('s:obj', val)
    const got = await redis.get<{ id: number; when: Date; tags: string[] }>('s:obj')
    expect(got?.id).toBe(1)
    expect(got?.when).toBeInstanceOf(Date)
    expect(got?.tags).toEqual(['a', 'b'])

    await redis.setEx('s:ttl', 'v', 100, 's')
    const t = await redis.ttl('s:ttl', 's')
    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThanOrEqual(100)

    expect(await redis.setIfAbsent('s:nx', 'first')).toBe(true)
    expect(await redis.setIfAbsent('s:nx', 'second')).toBe(false)
    expect(await redis.get<string>('s:nx')).toBe('first')

    await redis.del('s:counter')
    expect(await redis.incrBy('s:counter', 5)).toBe(5)
    expect(await redis.incrBy('s:counter', 3)).toBe(8)
    expect(await redis.decrBy('s:counter', 2)).toBe(6)

    await redis.multiSet({ 's:m1': 1, 's:m2': 2 })
    expect(await redis.multiGet<number>(['s:m1', 's:m2', 's:missing'])).toEqual([1, 2, null])
  })

  it('key: exists/type/rename/expire/persist, scan, batchSearch, del', async () => {
    await redis.set('k:1', 'v')
    expect(await redis.exists('k:1')).toBe(true)
    expect(await redis.type('k:1')).toBe('string')
    await redis.rename('k:1', 'k:2')
    expect(await redis.exists('k:2')).toBe(true)
    expect(await redis.expire('k:2', 60, 's')).toBe(true)
    expect(await redis.persist('k:2')).toBe(true)

    await redis.set('k:scan:1', 'a')
    await redis.set('k:scan:2', 'b')
    expect((await redis.scanKeys({ match: 'k:scan:*' })).sort()).toEqual(['k:scan:1', 'k:scan:2'])

    await redis.set('k:batch:1', { n: 1 })
    await redis.set('k:batch:2', { n: 2 })
    const out = await redis.batchSearch<{ n: number }>('k:batch:')
    expect(out['k:batch:1']).toEqual({ n: 1 })
    expect(out['k:batch:2']).toEqual({ n: 2 })

    await redis.set('k:del1', 'x')
    await redis.set('k:del2', 'y')
    expect(await redis.del(['k:del1', 'k:del2'])).toBe(2)
  })

  it('hash: hSet/hSetAll/hGet/hGetAll/hLen/hExists/hDel/hIncrBy', async () => {
    await redis.hSet('h:1', 'f1', 'v1')
    await redis.hSetAll('h:1', { f2: 'v2', f3: 'v3' })
    expect(await redis.hGet<string>('h:1', 'f1')).toBe('v1')
    expect(await redis.hGetAll<string>('h:1')).toEqual({ f1: 'v1', f2: 'v2', f3: 'v3' })
    expect(await redis.hLen('h:1')).toBe(3)
    expect(await redis.hExists('h:1', 'f2')).toBe(true)
    expect(await redis.hDel('h:1', 'f2')).toBe(1)
    expect(await redis.hIncrBy('h:1', 'count', 4)).toBe(4)
    expect(await redis.hIncrBy('h:1', 'count', 2)).toBe(6)
  })

  it('list: rPush/lPush/lRange/lLen/lPop/rPop/lIndex', async () => {
    await redis.rPush('l:1', 'b', 'c')
    await redis.lPush('l:1', 'a')
    expect(await redis.lRange<string>('l:1', 0, -1)).toEqual(['a', 'b', 'c'])
    expect(await redis.lLen('l:1')).toBe(3)
    expect(await redis.lPop<string>('l:1')).toBe('a')
    expect(await redis.rPop<string>('l:1')).toBe('c')
    expect(await redis.lIndex<string>('l:1', 0)).toBe('b')
  })

  it('set: sAdd/sMembers/sIsMember/sCard/sInter/sUnion/sDiff', async () => {
    await redis.sAdd('set:1', 'a', 'b', 'c')
    await redis.sAdd('set:2', 'b', 'c', 'd')
    expect((await redis.sMembers<string>('set:1')).sort()).toEqual(['a', 'b', 'c'])
    expect(await redis.sIsMember('set:1', 'b')).toBe(true)
    expect(await redis.sCard('set:1')).toBe(3)
    expect((await redis.sInter<string>('set:1', 'set:2')).sort()).toEqual(['b', 'c'])
    expect((await redis.sUnion<string>('set:1', 'set:2')).sort()).toEqual(['a', 'b', 'c', 'd'])
    expect((await redis.sDiff<string>('set:1', 'set:2')).sort()).toEqual(['a'])
  })

  it('zset: zAdd/zRange/zScore/zCard/zRangeWithScores/zIncrBy/zRevRange', async () => {
    await redis.zAdd('z:1', { score: 1, value: 'a' }, { score: 2, value: 'b' }, { score: 3, value: 'c' })
    expect(await redis.zRange<string>('z:1', 0, -1)).toEqual(['a', 'b', 'c'])
    expect(await redis.zScore('z:1', 'b')).toBe(2)
    expect(await redis.zCard('z:1')).toBe(3)
    expect(await redis.zRangeWithScores<string>('z:1', 0, 1)).toEqual([
      { value: 'a', score: 1 },
      { value: 'b', score: 2 },
    ])
    expect(await redis.zIncrBy('z:1', 5, 'a')).toBe(6)
    expect((await redis.zRevRange<string>('z:1', 0, -1))[0]).toBe('a')
  })

  it('pipeline + multi: batched and atomic execution', async () => {
    const pipelined = await redis.pipeline().set('p:1', 'v1').get('p:1').del('p:1').exec()
    expect(pipelined[0]).toBe('OK')
    expect(pipelined[1]).toBe('"v1"')
    expect(pipelined[2]).toBe(1)

    const tx = await redis.multi().set('tx:1', 'v1').get('tx:1').exec()
    expect(tx[0]).toBe('OK')
    expect(tx[1]).toBe('"v1"')
    expect(await redis.get<string>('tx:1')).toBe('v1')
  })

  it('lock: token-guarded tryLock/unlock, mutual exclusion, withLock, foreign token', async () => {
    const token = await redis.lock.tryLock('lock:1', 10, 's')
    expect(token).not.toBeNull()
    expect(await redis.lock.isHeldByMe('lock:1', token!)).toBe(true)
    expect(await redis.lock.unlock('lock:1', token!)).toBe(true)
    expect(await redis.lock.isHeldByMe('lock:1', token!)).toBe(false)

    const t1 = await redis.lock.tryLock('lock:2', 10, 's')
    expect(t1).not.toBeNull()
    expect(await redis.lock.tryLock('lock:2', 10, 's')).toBeNull()
    await redis.lock.unlock('lock:2', t1!)

    const r = await redis.lock.withLock('lock:3', async () => 42, { ttl: 10, unit: 's' })
    expect(r).toBe(42)
    expect(await redis.exists('lock:3')).toBe(false)

    const t4 = await redis.lock.tryLock('lock:4', 10, 's')
    const foreign = { key: 'lock:4', value: 'not-mine', ttlMs: 1000, acquiredAt: Date.now() }
    expect(await redis.lock.unlock('lock:4', foreign)).toBe(false)
    expect(await redis.lock.unlock('lock:4', t4!)).toBe(true)
  })

  it('governance: pool + executor telemetry are populated', async () => {
    const s = redis.stats()
    expect(s.pool.created).toBeGreaterThanOrEqual(1)
    expect(s.executor.completed).toBeGreaterThanOrEqual(1)
  })
})
