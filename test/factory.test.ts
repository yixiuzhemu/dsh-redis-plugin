import { describe, expect, it } from 'vitest'
import { createConnectionFactory, type ClientCtor } from '../src/connection/factory.js'
import { RedisPluginError } from '../src/types.js'
import type { ConnectionConfig } from '../src/config.js'

/** A ctor that records the options ioredis would be constructed with. */
function capturingCtor(): { ctor: ClientCtor; seen: unknown[] } {
  const seen: unknown[] = []
  const ctor = function (this: unknown, opts: unknown) {
    seen.push(opts)
  } as unknown as ClientCtor
  return { ctor, seen }
}

function base(over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return { topology: 'standalone', ...over }
}

describe('createConnectionFactory', () => {
  it('builds standalone options from host/port/db', () => {
    const { ctor, seen } = capturingCtor()
    const f = createConnectionFactory(base({ host: 'redis.local', port: 6380, db: 3 }), ctor)
    expect(f.topology).toBe('standalone')
    f.create()
    expect(seen[0]).toMatchObject({
      host: 'redis.local',
      port: 6380,
      db: 3,
      lazyConnect: false,
      enableOfflineQueue: true,
    })
  })

  it('defaults host/port/db when omitted', () => {
    const { ctor, seen } = capturingCtor()
    createConnectionFactory(base(), ctor).create()
    expect(seen[0]).toMatchObject({ host: '127.0.0.1', port: 6379, db: 0 })
  })

  it('prefers url over host/port when provided', () => {
    const { ctor, seen } = capturingCtor()
    createConnectionFactory(base({ url: 'redis://user@host:6379/2' }), ctor).create()
    expect(seen[0]).toBe('redis://user@host:6379/2')
  })

  it('passes through credentials and normalizes tls', () => {
    const { ctor, seen } = capturingCtor()
    createConnectionFactory(base({ password: 'p', username: 'u', tls: true }), ctor).create()
    expect(seen[0]).toMatchObject({ password: 'p', username: 'u', tls: {} })

    const obj = capturingCtor()
    createConnectionFactory(base({ tls: { ca: 'cert-data' } }), obj.ctor).create()
    expect(obj.seen[0]).toMatchObject({ tls: { ca: 'cert-data' } })
  })

  it('sets maxRetriesPerRequest to null so the executor owns retry semantics', () => {
    const { ctor, seen } = capturingCtor()
    createConnectionFactory(base(), ctor).create()
    expect(seen[0]).toMatchObject({ maxRetriesPerRequest: null })
  })

  it('fails loud for reserved (unimplemented) topologies', () => {
    expect(() => createConnectionFactory(base({ topology: 'sentinel' }))).toThrow(RedisPluginError)
    expect(() => createConnectionFactory(base({ topology: 'cluster' }))).toThrow(/not implemented/i)
  })

  it('fails loud for an unknown topology', () => {
    const bogus = { topology: 'nope' as unknown as ConnectionConfig['topology'] }
    expect(() => createConnectionFactory(bogus)).toThrow(/Unknown topology/)
  })
})
