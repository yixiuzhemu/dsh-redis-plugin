import { describe, expect, it } from 'vitest'
import RedisMock from 'ioredis-mock'
import { createRedis } from '../src/service.js'
import type { RedisService } from '../src/service.js'
import type { ClientCtor } from '../src/connection/factory.js'

const MockCtor = RedisMock as unknown as ClientCtor

function makeService(): RedisService {
  return createRedis(
    { pool: { min: 1, max: 2, healthCheckMs: 0 }, executor: { coreSize: 4, maxSize: 4, retry: { maxAttempts: 1, backoffMs: 1 } } },
    { clientCtor: MockCtor },
  )
}

describe('createRedis / RedisService', () => {
  it('wires the full surface: operations, lock, stats, lifecycle', async () => {
    const redis = makeService()
    expect(typeof redis.get).toBe('function')
    expect(typeof redis.pipeline).toBe('function')
    expect(typeof redis.multi).toBe('function')
    expect(redis.lock).toBeDefined()

    await redis.start()
    await redis.set('svc:k', { hello: 'world' })
    expect(await redis.get<{ hello: string }>('svc:k')).toEqual({ hello: 'world' })

    const s = redis.stats()
    expect(s.pool).toHaveProperty('idle')
    expect(s.executor).toHaveProperty('completed')
    expect(s.executor.completed).toBeGreaterThanOrEqual(1)

    await redis.dispose()
  })

  it('start() is idempotent (a second call does not re-warm the pool)', async () => {
    const redis = makeService()
    await redis.start()
    const afterFirst = redis.stats().pool.created
    await redis.start()
    expect(redis.stats().pool.created).toBe(afterFirst)
    await redis.dispose()
  })

  it('rejects commands after dispose', async () => {
    const redis = makeService()
    await redis.start()
    await redis.dispose()
    await expect(redis.get('svc:k')).rejects.toThrow(/disposed/)
  })
})
