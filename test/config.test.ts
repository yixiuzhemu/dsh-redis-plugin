import { describe, expect, it } from 'vitest'
import { defaultConfig, resolveConfig } from '../src/config.js'

describe('resolveConfig', () => {
  it('returns the full defaults for empty input', () => {
    expect(resolveConfig()).toEqual(defaultConfig)
    expect(resolveConfig({})).toEqual(defaultConfig)
  })

  it('deep-merges a partial connection over the defaults', () => {
    const c = resolveConfig({ connection: { host: 'redis.local', port: 6380 } })
    expect(c.connection.host).toBe('redis.local')
    expect(c.connection.port).toBe(6380)
    // Untouched siblings keep their defaults.
    expect(c.connection.topology).toBe('standalone')
    expect(c.connection.db).toBe(defaultConfig.connection.db)
  })

  it('ignores undefined so patch layers compose cleanly', () => {
    const c = resolveConfig({ pool: { min: undefined, max: 5 } })
    expect(c.pool.min).toBe(defaultConfig.pool.min)
    expect(c.pool.max).toBe(5)
  })

  it('deep-merges the nested executor.retry object', () => {
    const c = resolveConfig({ executor: { retry: { maxAttempts: 9 } } })
    expect(c.executor.retry.maxAttempts).toBe(9)
    expect(c.executor.retry.backoffMs).toBe(defaultConfig.executor.retry.backoffMs)
    expect(c.executor.coreSize).toBe(defaultConfig.executor.coreSize)
  })

  it('does not mutate the shared defaultConfig', () => {
    resolveConfig({ connection: { port: 1 }, lock: { defaultTtlMs: 1 } })
    expect(defaultConfig.connection.port).toBe(6379)
    expect(defaultConfig.lock.defaultTtlMs).toBe(30_000)
  })

  it('preserves an explicit false/0 override (falsy but defined)', () => {
    const c = resolveConfig({ tools: { enabled: false }, codec: { typeHint: false } })
    expect(c.tools.enabled).toBe(false)
    expect(c.codec.typeHint).toBe(false)
  })
})
