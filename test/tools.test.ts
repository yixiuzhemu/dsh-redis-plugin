import { beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { buildToolDefs } from '../src/tools/defs.js'
import { installGuard } from '../src/tools/guard.js'
import { registerRedisTools } from '../src/tools/index.js'
import type { ToolsConfig } from '../src/config.js'
import type { RedisService } from '../src/service.js'

/**
 * A lightweight stand-in for RedisService. The tool `execute()` bodies only
 * touch a small slice of the surface, and hand-rolling it avoids ioredis-mock's
 * unreliable Lua support (needed by the lock tools).
 */
function makeFakeService(): { svc: RedisService; data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  const svc = {
    async get(key: string) {
      return data.has(key) ? (data.get(key) ?? null) : null
    },
    async set(key: string, value: unknown) {
      data.set(key, value)
      return 'OK'
    },
    async del(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys]
      let n = 0
      for (const k of list) if (data.delete(k)) n++
      return n
    },
    async *scan(_opts?: unknown): AsyncIterableIterator<string> {
      for (const k of [...data.keys()]) yield k
    },
    async exists(key: string) {
      return data.has(key)
    },
    async ttl() {
      return -1
    },
    async type() {
      return 'string'
    },
    async hGetAll() {
      return {}
    },
    async hSet() {
      return 1
    },
    async incrBy(key: string, n = 1) {
      const v = Number(data.get(key) ?? 0) + n
      data.set(key, v)
      return v
    },
    lock: {
      async tryLock(key: string) {
        return { key, value: 'tok-123', ttlMs: 30_000, acquiredAt: 0 }
      },
      async unlock() {
        return true
      },
    },
  }
  return { svc: svc as unknown as RedisService, data }
}

function fakeCtx(opts: { withTools?: boolean } = {}): {
  ctx: Context
  registered: ToolDefinition[]
  listeners: Map<string, (...a: never[]) => unknown>
  logs: string[]
} {
  const registered: ToolDefinition[] = []
  const listeners = new Map<string, (...a: never[]) => unknown>()
  const logs: string[] = []
  const ctx = {
    logger: {
      debug: () => void 0,
      info: (...a: unknown[]) => logs.push(a.join(' ')),
      warn: (...a: unknown[]) => logs.push('warn: ' + a.join(' ')),
      error: () => void 0,
    },
    tools:
      opts.withTools === false
        ? undefined
        : {
            register: (d: ToolDefinition) => {
              registered.push(d)
              return () => void 0
            },
          },
    on: (ev: string, fn: (...a: never[]) => unknown) => {
      listeners.set(ev, fn)
      return () => void 0
    },
    provide: () => () => void 0,
    effect: () => () => void 0,
    get: () => undefined,
  }
  return { ctx: ctx as unknown as Context, registered, listeners, logs }
}

const toolsConfig: ToolsConfig = { enabled: true, allowDestructive: false }

function pick(defs: ToolDefinition[], name: string): ToolDefinition {
  const t = defs.find((d) => d.name === name)
  if (!t) throw new Error(`missing tool: ${name}`)
  return t
}

function execFor(name: string): ToolExecution {
  return { name, args: {}, signal: new AbortController().signal }
}

describe('buildToolDefs', () => {
  let defs: ToolDefinition[]
  let data: Map<string, unknown>
  let svc: RedisService

  beforeEach(() => {
    const fake = makeFakeService()
    svc = fake.svc
    data = fake.data
    defs = buildToolDefs(svc, toolsConfig)
  })

  it('builds the 12 documented redis_* tools', () => {
    expect(defs.map((d) => d.name).sort()).toEqual([
      'redis_del',
      'redis_exists',
      'redis_get',
      'redis_hgetall',
      'redis_hset',
      'redis_incrby',
      'redis_lock',
      'redis_scan',
      'redis_set',
      'redis_ttl',
      'redis_type',
      'redis_unlock',
    ])
  })

  it('redis_set JSON-decodes the value, redis_get reads it back', async () => {
    const setRes = await pick(defs, 'redis_set').execute(
      { key: 'k', value: '{"n":1}' },
      execFor('redis_set'),
    )
    expect(setRes).toMatchObject({ key: 'k', ok: true })
    expect(data.get('k')).toEqual({ n: 1 })

    const getRes = await pick(defs, 'redis_get').execute({ key: 'k' }, execFor('redis_get'))
    expect(getRes).toEqual({ key: 'k', value: { n: 1 }, exists: true })
  })

  it('redis_get reports exists=false for a missing key', async () => {
    const res = await pick(defs, 'redis_get').execute({ key: 'nope' }, execFor('redis_get'))
    expect(res).toEqual({ key: 'nope', value: null, exists: false })
  })

  it('redis_del returns the number of keys removed', async () => {
    data.set('a', 1)
    data.set('b', 2)
    const res = await pick(defs, 'redis_del').execute(
      { keys: ['a', 'b', 'missing'] },
      execFor('redis_del'),
    )
    expect(res).toEqual({ deleted: 2 })
  })

  it('redis_scan honours the limit and flags truncation', async () => {
    for (let i = 0; i < 5; i++) data.set(`k${i}`, i)
    const res = (await pick(defs, 'redis_scan').execute(
      { match: '*', limit: 3 },
      execFor('redis_scan'),
    )) as { keys: string[]; count: number; truncated: boolean }
    expect(res.count).toBe(3)
    expect(res.keys.length).toBe(3)
    expect(res.truncated).toBe(true)
  })

  it('redis_incrby applies the amount (default 1)', async () => {
    const r1 = await pick(defs, 'redis_incrby').execute({ key: 'c', amount: 5 }, execFor('redis_incrby'))
    expect(r1).toEqual({ key: 'c', value: 5 })
    const r2 = await pick(defs, 'redis_incrby').execute({ key: 'c' }, execFor('redis_incrby'))
    expect(r2).toEqual({ key: 'c', value: 6 })
  })

  it('metadata tools report exists / type / ttl', async () => {
    data.set('m', 'v')
    expect(await pick(defs, 'redis_exists').execute({ key: 'm' }, execFor('redis_exists'))).toEqual({
      key: 'm',
      exists: true,
    })
    expect(await pick(defs, 'redis_type').execute({ key: 'm' }, execFor('redis_type'))).toEqual({
      key: 'm',
      type: 'string',
    })
    expect(await pick(defs, 'redis_ttl').execute({ key: 'm' }, execFor('redis_ttl'))).toEqual({
      key: 'm',
      ttl: -1,
    })
  })

  it('redis_hset / redis_hgetall shape their results', async () => {
    const setRes = await pick(defs, 'redis_hset').execute(
      { key: 'h', field: 'f', value: '"v"' },
      execFor('redis_hset'),
    )
    expect(setRes).toEqual({ key: 'h', field: 'f', added: 1 })
    const getRes = await pick(defs, 'redis_hgetall').execute({ key: 'h' }, execFor('redis_hgetall'))
    expect(getRes).toEqual({ key: 'h', value: {} })
  })

  it('redis_lock returns a token and redis_unlock releases it', async () => {
    const locked = await pick(defs, 'redis_lock').execute(
      { key: 'r', ttlSeconds: 30 },
      execFor('redis_lock'),
    )
    expect(locked).toEqual({ key: 'r', acquired: true, token: 'tok-123' })
    const unlocked = await pick(defs, 'redis_unlock').execute(
      { key: 'r', token: 'tok-123' },
      execFor('redis_unlock'),
    )
    expect(unlocked).toEqual({ key: 'r', released: true })
  })
})

describe('installGuard', () => {
  type Guard = (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>

  function guardWith(allowDestructive: boolean): Guard {
    const { ctx, listeners } = fakeCtx()
    installGuard(ctx, allowDestructive)
    return listeners.get('tools/pre-execute') as unknown as Guard
  }

  it('denies a destructive tool when allowDestructive=false (without calling next)', async () => {
    const { ctx, listeners } = fakeCtx()
    installGuard(ctx, false)
    const guard = listeners.get('tools/pre-execute') as unknown as Guard
    let nextCalled = false
    const decision = await guard(execFor('redis_del'), async () => {
      nextCalled = true
      return { kind: 'allow' }
    })
    expect(decision).toMatchObject({ kind: 'deny' })
    expect(nextCalled).toBe(false)
  })

  it('calls next() for a non-destructive tool', async () => {
    const guard = guardWith(false)
    let nextCalled = false
    const decision = await guard(execFor('redis_get'), async () => {
      nextCalled = true
      return { kind: 'allow' }
    })
    expect(decision).toEqual({ kind: 'allow' })
    expect(nextCalled).toBe(true)
  })

  it('allows a destructive tool when allowDestructive=true', async () => {
    const guard = guardWith(true)
    const decision = await guard(execFor('redis_del'), async () => ({ kind: 'allow' }))
    expect(decision).toEqual({ kind: 'allow' })
  })
})

describe('registerRedisTools', () => {
  it('registers every tool and installs the pre-execute guard', () => {
    const { ctx, registered, listeners } = fakeCtx()
    const { svc } = makeFakeService()
    registerRedisTools(ctx, svc, toolsConfig)
    expect(registered.length).toBe(12)
    expect(listeners.has('tools/pre-execute')).toBe(true)
  })

  it('skips registration and warns when ctx.tools is unavailable', () => {
    const { ctx, registered, logs } = fakeCtx({ withTools: false })
    const { svc } = makeFakeService()
    registerRedisTools(ctx, svc, toolsConfig)
    expect(registered.length).toBe(0)
    expect(logs.some((l) => l.includes('ctx.tools unavailable'))).toBe(true)
  })
})
