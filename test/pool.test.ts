import { describe, expect, it } from 'vitest'
import { ConnectionPool } from '../src/connection/pool.js'
import type { ConnectionFactory, RedisClient } from '../src/connection/factory.js'
import type { PoolConfig } from '../src/config.js'

function cfg(over: Partial<PoolConfig> = {}): PoolConfig {
  return { min: 0, max: 2, idleTimeoutMs: 1000, healthCheckMs: 0, ...over }
}

/** Minimal ioredis surface the pool relies on: ping / quit / disconnect. */
class FakeClient {
  quitCalls = 0
  disconnectCalls = 0
  pingImpl: () => Promise<string> = async () => 'PONG'

  async ping(): Promise<string> {
    return this.pingImpl()
  }

  async quit(): Promise<'OK'> {
    this.quitCalls++
    return 'OK'
  }

  disconnect(): void {
    this.disconnectCalls++
  }
}

function makeFactory(): { factory: ConnectionFactory; created: FakeClient[] } {
  const created: FakeClient[] = []
  const factory: ConnectionFactory = {
    topology: 'standalone',
    create: () => {
      const c = new FakeClient()
      created.push(c)
      return c as unknown as RedisClient
    },
  }
  return { factory, created }
}

describe('ConnectionPool', () => {
  it('warms up the minimum number of idle connections on start', async () => {
    const { factory, created } = makeFactory()
    const pool = new ConnectionPool(factory, cfg({ min: 2, max: 4 }))
    await pool.start()
    expect(created.length).toBe(2)
    expect(pool.stats().idle).toBe(2)
    await pool.dispose()
  })

  it('reuses a released idle connection instead of creating a new one', async () => {
    const { factory, created } = makeFactory()
    const pool = new ConnectionPool(factory, cfg({ min: 1, max: 2 }))
    await pool.start()
    const l1 = await pool.acquire()
    expect(l1.client).toBe(created[0] as unknown as RedisClient)
    l1.release()
    expect(pool.stats().idle).toBe(1)
    const l2 = await pool.acquire()
    expect(l2.client).toBe(l1.client)
    expect(created.length).toBe(1)
    l2.release()
    await pool.dispose()
  })

  it('bounds at max, queues waiters, and hands the connection off on release', async () => {
    const { factory, created } = makeFactory()
    const pool = new ConnectionPool(factory, cfg({ min: 0, max: 1 }))
    const l1 = await pool.acquire()
    expect(created.length).toBe(1)

    const queued = pool.acquire()
    expect(pool.stats().waiting).toBe(1)

    l1.release()
    const l2 = await queued
    expect(pool.stats().waiting).toBe(0)
    expect(l2.client).toBe(l1.client) // same connection handed to the waiter
    l2.release()
    await pool.dispose()
  })

  it('gives blocking/pubsub their own persistent, dedicated connections', async () => {
    const { factory, created } = makeFactory()
    const pool = new ConnectionPool(factory, cfg({ min: 0, max: 2 }))
    const b1 = await pool.acquire('blocking')
    const b2 = await pool.acquire('blocking')
    expect(b1.client).toBe(b2.client) // dedicated connection is reused
    const ps = await pool.acquire('pubsub')
    expect(ps.client).not.toBe(b1.client) // different kind → different connection
    const def = await pool.acquire()
    expect(def.client).not.toBe(b1.client)
    b1.release() // no-op for dedicated leases
    expect(created.length).toBe(3) // blocking + pubsub + default
    def.release()
    await pool.dispose()
  })

  it('evicts unhealthy idle connections during a health check', async () => {
    const { factory, created } = makeFactory()
    const pool = new ConnectionPool(factory, cfg({ min: 1, max: 2, healthCheckMs: 0 }))
    await pool.start()
    expect(pool.stats().idle).toBe(1)

    const sick = created[0]!
    sick.pingImpl = async () => {
      throw new Error('dead connection')
    }
    await (pool as unknown as { healthCheck(): Promise<void> }).healthCheck()

    expect(pool.stats().idle).toBe(0)
    expect(sick.quitCalls + sick.disconnectCalls).toBeGreaterThanOrEqual(1)
    await pool.dispose()
  })

  it('force-drops a connection on lease.destroy() and never reuses it', async () => {
    const { factory, created } = makeFactory()
    const pool = new ConnectionPool(factory, cfg({ min: 0, max: 1 }))
    const l1 = await pool.acquire()
    l1.destroy()

    expect((created[0] as FakeClient).disconnectCalls).toBe(1)
    const s = pool.stats()
    expect(s.active).toBe(0)
    expect(s.idle).toBe(0)
    expect(s.destroyed).toBe(1)

    // With max=1, a leaked connection would wedge this; a fresh one is built.
    const l2 = await pool.acquire()
    expect(created.length).toBe(2)
    expect(l2.client).not.toBe(l1.client)
    l2.release()
    await pool.dispose()
  })

  it('settles a lease once: release after destroy is a no-op', async () => {
    const { factory } = makeFactory()
    const pool = new ConnectionPool(factory, cfg({ min: 0, max: 1 }))
    const l1 = await pool.acquire()
    l1.destroy()
    l1.release() // must not push the dead connection back into the idle set
    expect(pool.stats().idle).toBe(0)
    await pool.dispose()
  })

  it('rejects pending waiters and quits connections on dispose', async () => {
    const { factory, created } = makeFactory()
    const pool = new ConnectionPool(factory, cfg({ min: 0, max: 1 }))
    await pool.acquire()
    const waiting = pool.acquire()
    const rejection = expect(waiting).rejects.toThrow(/disposed/)
    await pool.dispose()
    await rejection
    expect((created[0] as FakeClient).quitCalls).toBeGreaterThanOrEqual(1)
  })

  it('rejects acquire after the pool is closed', async () => {
    const { factory } = makeFactory()
    const pool = new ConnectionPool(factory, cfg())
    await pool.dispose()
    await expect(pool.acquire()).rejects.toThrow(/closed/)
  })
})
