import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import RedisMock from 'ioredis-mock'
import { createRedis } from '../src/service.js'
import type { RedisService } from '../src/service.js'
import type { ClientCtor } from '../src/connection/factory.js'

const MockCtor = RedisMock as unknown as ClientCtor

let redis: RedisService

/** Wipe every key between tests (single shared connection ⇒ shared data). */
async function flush(): Promise<void> {
  const keys = await redis.scanKeys({ match: '*' })
  if (keys.length > 0) await redis.del(keys)
}

beforeAll(async () => {
  redis = createRedis(
    {
      // One shared connection so all commands hit the same in-memory dataset.
      pool: { min: 1, max: 1, healthCheckMs: 0 },
      executor: { coreSize: 4, maxSize: 4, retry: { maxAttempts: 1, backoffMs: 1 } },
    },
    { clientCtor: MockCtor },
  )
  await redis.start()
})

beforeEach(flush)

afterAll(async () => {
  await redis.dispose()
})

describe('string operations', () => {
  it('round-trips JSON values through set/get', async () => {
    await redis.set('user:1', { id: 1, name: 'ada', tags: ['x', 'y'] })
    const got = await redis.get<{ id: number; name: string; tags: string[] }>('user:1')
    expect(got).toEqual({ id: 1, name: 'ada', tags: ['x', 'y'] })
  })

  it('returns null for a missing key', async () => {
    expect(await redis.get('nope')).toBeNull()
  })

  it('honours setIfAbsent (NX) semantics', async () => {
    expect(await redis.setIfAbsent('nx', 'first')).toBe(true)
    expect(await redis.setIfAbsent('nx', 'second')).toBe(false)
    expect(await redis.get<string>('nx')).toBe('first')
  })

  it('supports setEx + ttl reporting', async () => {
    await redis.setEx('temp', 'v', 100, 's')
    const ttl = await redis.ttl('temp', 's')
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(100)
  })

  it('increments and decrements counters', async () => {
    expect(await redis.incrBy('counter', 5)).toBe(5)
    expect(await redis.incrBy('counter', 3)).toBe(8)
    expect(await redis.decrBy('counter', 2)).toBe(6)
  })

  it('multiSet / multiGet round-trip', async () => {
    await redis.multiSet({ a: 1, b: 2, c: 3 })
    expect(await redis.multiGet<number>(['a', 'b', 'c', 'missing'])).toEqual([1, 2, 3, null])
  })
})

describe('key operations', () => {
  it('del / exists', async () => {
    await redis.set('k1', 'v')
    expect(await redis.exists('k1')).toBe(true)
    expect(await redis.del('k1')).toBe(1)
    expect(await redis.exists('k1')).toBe(false)
  })

  it('expire / persist / type', async () => {
    await redis.set('typed', 'v')
    expect(await redis.type('typed')).toBe('string')
    expect(await redis.expire('typed', 60, 's')).toBe(true)
    expect(await redis.persist('typed')).toBe(true)
  })

  it('scanKeys collects a prefix family', async () => {
    await redis.set('p:1', 'a')
    await redis.set('p:2', 'b')
    await redis.set('q:1', 'c')
    const keys = (await redis.scanKeys({ match: 'p:*' })).sort()
    expect(keys).toEqual(['p:1', 'p:2'])
  })

  it('scan yields keys as an async iterator', async () => {
    await redis.set('it:1', 'a')
    await redis.set('it:2', 'b')
    const seen: string[] = []
    for await (const k of redis.scan({ match: 'it:*' })) seen.push(k)
    expect(seen.sort()).toEqual(['it:1', 'it:2'])
  })

  it('batchSearch returns every value under a prefix', async () => {
    await redis.set('b:1', { n: 1 })
    await redis.set('b:2', { n: 2 })
    const out = await redis.batchSearch<{ n: number }>('b:')
    expect(out).toEqual({ 'b:1': { n: 1 }, 'b:2': { n: 2 } })
  })
})

describe('hash operations', () => {
  it('hSet / hGet / hGetAll', async () => {
    await redis.hSet('h', 'f1', 'v1')
    await redis.hSetAll('h', { f2: 'v2', f3: 'v3' })
    expect(await redis.hGet<string>('h', 'f1')).toBe('v1')
    expect(await redis.hGetAll<string>('h')).toEqual({ f1: 'v1', f2: 'v2', f3: 'v3' })
    expect(await redis.hLen('h')).toBe(3)
  })

  it('hExists / hDel / hIncrBy', async () => {
    await redis.hSet('h2', 'a', 'v')
    expect(await redis.hExists('h2', 'a')).toBe(true)
    // hIncrBy operates on native integer fields (a fresh field starts at 0).
    expect(await redis.hIncrBy('h2', 'count', 4)).toBe(4)
    expect(await redis.hDel('h2', 'a')).toBe(1)
    expect(await redis.hExists('h2', 'a')).toBe(false)
  })
})

describe('list operations', () => {
  it('lPush / rPush / lRange / lLen', async () => {
    await redis.rPush('l', 'b', 'c')
    await redis.lPush('l', 'a')
    expect(await redis.lRange<string>('l', 0, -1)).toEqual(['a', 'b', 'c'])
    expect(await redis.lLen('l')).toBe(3)
  })

  it('lPop / rPop / lIndex', async () => {
    await redis.rPush('l2', 'x', 'y', 'z')
    expect(await redis.lPop<string>('l2')).toBe('x')
    expect(await redis.rPop<string>('l2')).toBe('z')
    expect(await redis.lIndex<string>('l2', 0)).toBe('y')
  })
})

describe('set operations', () => {
  it('sAdd / sMembers / sIsMember / sCard', async () => {
    await redis.sAdd('s', 'a', 'b', 'c')
    expect((await redis.sMembers<string>('s')).sort()).toEqual(['a', 'b', 'c'])
    expect(await redis.sIsMember('s', 'b')).toBe(true)
    expect(await redis.sIsMember('s', 'zzz')).toBe(false)
    expect(await redis.sCard('s')).toBe(3)
  })

  it('sInter / sUnion / sDiff', async () => {
    await redis.sAdd('s1', 'a', 'b', 'c')
    await redis.sAdd('s2', 'b', 'c', 'd')
    expect((await redis.sInter<string>('s1', 's2')).sort()).toEqual(['b', 'c'])
    expect((await redis.sUnion<string>('s1', 's2')).sort()).toEqual(['a', 'b', 'c', 'd'])
    expect((await redis.sDiff<string>('s1', 's2')).sort()).toEqual(['a'])
  })
})

describe('zset operations', () => {
  it('zAdd / zRange / zScore / zCard', async () => {
    await redis.zAdd('z', { score: 1, value: 'a' }, { score: 2, value: 'b' }, { score: 3, value: 'c' })
    expect(await redis.zRange<string>('z', 0, -1)).toEqual(['a', 'b', 'c'])
    expect(await redis.zScore('z', 'b')).toBe(2)
    expect(await redis.zCard('z')).toBe(3)
  })

  it('zRangeWithScores / zRevRange / zIncrBy', async () => {
    await redis.zAdd('z2', { score: 10, value: 'x' }, { score: 20, value: 'y' })
    expect(await redis.zRangeWithScores<string>('z2', 0, -1)).toEqual([
      { value: 'x', score: 10 },
      { value: 'y', score: 20 },
    ])
    expect(await redis.zRevRange<string>('z2', 0, -1)).toEqual(['y', 'x'])
    expect(await redis.zIncrBy('z2', 5, 'x')).toBe(15)
  })
})

describe('pipeline', () => {
  it('batches set/get/del in one round-trip', async () => {
    const results = await redis
      .pipeline()
      .set('pipe:1', 'v1')
      .set('pipe:2', 'v2')
      .get('pipe:1')
      .exec()
    // pipeline mirrors RedisTemplate.executePipelined: results are the raw,
    // still-encoded command outputs (values are NOT deserialized here).
    expect(results[0]).toBe('OK')
    expect(results[1]).toBe('OK')
    expect(results[2]).toBe('"v1"')
  })
})

describe('multi (transaction)', () => {
  it('applies queued commands atomically via MULTI/EXEC', async () => {
    const results = await redis
      .multi()
      .set('tx:1', 'v1')
      .get('tx:1')
      .exec()
    // Like pipeline(), transaction results are the raw, still-encoded outputs.
    expect(results[0]).toBe('OK')
    expect(results[1]).toBe('"v1"')
    expect(await redis.get<string>('tx:1')).toBe('v1')
  })
})

describe('governance', () => {
  it('exposes pool + executor stats', async () => {
    await redis.set('stat', 'v')
    const s = redis.stats()
    expect(s.pool.created).toBeGreaterThanOrEqual(1)
    expect(s.executor.completed).toBeGreaterThanOrEqual(1)
  })
})

describe('timeout connection reclaim (regression)', () => {
  /**
   * A client whose reads hang until the socket is torn down, emulating an
   * unreachable/stalled Redis. `disconnect()` rejects the in-flight command,
   * exactly as real ioredis does.
   */
  class HangingClient {
    status = 'ready'
    private pending: Array<(e: Error) => void> = []
    get(_key: string): Promise<string | null> {
      return new Promise<string | null>((_resolve, reject) => {
        this.pending.push(reject)
      })
    }
    set(_key: string, _value: unknown): Promise<'OK'> {
      return Promise.resolve('OK')
    }
    ping(): Promise<string> {
      return Promise.resolve('PONG')
    }
    quit(): Promise<'OK'> {
      return Promise.resolve('OK')
    }
    disconnect(): void {
      const pending = this.pending
      this.pending = []
      for (const reject of pending) reject(new Error('Connection is closed.'))
    }
  }

  it('force-destroys the connection on timeout so the pool is not exhausted', async () => {
    const hanging = createRedis(
      {
        pool: { min: 0, max: 1, healthCheckMs: 0 },
        executor: { coreSize: 2, maxSize: 2, timeoutMs: 30, retry: { maxAttempts: 1, backoffMs: 1 } },
      },
      { clientCtor: HangingClient as unknown as ClientCtor },
    )

    // The read hangs and is aborted by the executor timeout.
    await expect(hanging.get('x')).rejects.toThrow(/timed out/i)

    // The hung connection was reclaimed (not leaked, not returned to the pool).
    const stats = hanging.stats()
    expect(stats.pool.destroyed).toBeGreaterThanOrEqual(1)
    expect(stats.pool.active).toBe(0)

    // With max=1, a leaked connection would wedge this forever; it must succeed.
    await expect(hanging.set('y', 'v')).resolves.toBe('OK')

    await hanging.dispose()
  })
})
