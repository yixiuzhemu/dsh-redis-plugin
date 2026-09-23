import type { SetOptions, TimeUnit } from '../types.js'
import { toMillis } from '../types.js'
import { dv, ek, ev, run, type OpsContext } from './context.js'

/** Loose call helper for ioredis methods with complex overloads (e.g. SET). */
type AnyCall = (...args: unknown[]) => Promise<unknown>

/** String operations — mirrors the "string相关操作" group of `RedisUtils<T>`. */
export function stringOps(ctx: OpsContext) {
  function setArgs(opts?: SetOptions): Array<string | number> {
    const args: Array<string | number> = []
    if (!opts) return args
    if (opts.ex !== undefined) args.push('EX', opts.ex)
    else if (opts.px !== undefined) args.push('PX', opts.px)
    if (opts.nx) args.push('NX')
    if (opts.xx) args.push('XX')
    return args
  }

  return {
    async get<T>(key: string): Promise<T | null> {
      const k = ek(ctx, key)
      const raw = await run(ctx, (c) => c.get(k) as Promise<string | null>, { retryable: true })
      return dv<T>(ctx, raw)
    },

    async set(key: string, value: unknown, opts?: SetOptions): Promise<'OK' | null> {
      const k = ek(ctx, key)
      const v = ev(ctx, value)
      const extra = setArgs(opts)
      return run(
        ctx,
        (c) => (c.set as AnyCall)(k, v, ...extra) as Promise<'OK' | null>,
        { retryable: extra.length === 0 || !opts?.nx },
      )
    },

    async setEx(key: string, value: unknown, ttl: number, unit: TimeUnit = 's'): Promise<void> {
      const k = ek(ctx, key)
      const v = ev(ctx, value)
      await run(ctx, (c) => c.psetex(k, toMillis(ttl, unit), v))
    },

    /** SET key value NX [PX ttl]; returns true when the key was absent. */
    async setIfAbsent(key: string, value: unknown, ttl?: number, unit: TimeUnit = 'ms'): Promise<boolean> {
      const k = ek(ctx, key)
      const v = ev(ctx, value)
      const extra: Array<string | number> = ['NX']
      if (ttl !== undefined) extra.push('PX', toMillis(ttl, unit))
      const res = await run(ctx, (c) => (c.set as AnyCall)(k, v, ...extra) as Promise<'OK' | null>)
      return res === 'OK'
    },

    async getAndSet<T>(key: string, value: unknown): Promise<T | null> {
      const k = ek(ctx, key)
      const v = ev(ctx, value)
      const raw = await run(ctx, (c) => c.getset(k, v) as Promise<string | null>)
      return dv<T>(ctx, raw)
    },

    async getRange(key: string, start: number, end: number): Promise<string> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.getrange(k, start, end), { retryable: true })
    },

    async setRange(key: string, value: string, offset: number): Promise<number> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.setrange(k, offset, value))
    },

    async size(key: string): Promise<number> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.strlen(k), { retryable: true })
    },

    async append(key: string, value: string): Promise<number> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.append(k, value))
    },

    async incrBy(key: string, increment = 1): Promise<number> {
      const k = ek(ctx, key)
      // Non-idempotent: never retried.
      return run(ctx, (c) => c.incrby(k, increment))
    },

    async incrByFloat(key: string, increment: number): Promise<number> {
      const k = ek(ctx, key)
      const res = await run(ctx, (c) => c.incrbyfloat(k, increment))
      return Number(res)
    },

    async decrBy(key: string, decrement = 1): Promise<number> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.decrby(k, decrement))
    },

    async getBit(key: string, offset: number): Promise<number> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.getbit(k, offset), { retryable: true })
    },

    async setBit(key: string, offset: number, value: 0 | 1): Promise<number> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.setbit(k, offset, value))
    },

    async multiGet<T>(keys: string[]): Promise<Array<T | null>> {
      const encoded = keys.map((k) => ek(ctx, k))
      if (encoded.length === 0) return []
      const rows = await run(
        ctx,
        (c) => c.mget(...encoded) as Promise<Array<string | null>>,
        { retryable: true },
      )
      return rows.map((r) => dv<T>(ctx, r))
    },

    async multiSet(map: Record<string, unknown>): Promise<void> {
      const flat: Array<string | Buffer> = []
      for (const [k, v] of Object.entries(map)) {
        flat.push(ek(ctx, k), ev(ctx, v))
      }
      if (flat.length === 0) return
      await run(ctx, (c) => (c.mset as AnyCall)(...flat) as Promise<unknown>)
    },

    async multiSetIfAbsent(map: Record<string, unknown>): Promise<boolean> {
      const flat: Array<string | Buffer> = []
      for (const [k, v] of Object.entries(map)) {
        flat.push(ek(ctx, k), ev(ctx, v))
      }
      if (flat.length === 0) return true
      const n = await run(ctx, (c) => (c.msetnx as AnyCall)(...flat) as Promise<number>)
      return n === 1
    },
  }
}

export type StringOps = ReturnType<typeof stringOps>
