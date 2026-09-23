import { dv, ek, ev, run, runDedicated, type OpsContext } from './context.js'

/** List operations — mirrors the "list相关操作" group of `RedisUtils<T>`. */
export function listOps(ctx: OpsContext) {
  return {
    async lPush(key: string, ...values: unknown[]): Promise<number> {
      const k = ek(ctx, key)
      if (values.length === 0) return 0
      const encoded = values.map((v) => ev(ctx, v))
      return run(ctx, (c) => (c.lpush as (...a: unknown[]) => Promise<number>)(k, ...encoded))
    },

    async rPush(key: string, ...values: unknown[]): Promise<number> {
      const k = ek(ctx, key)
      if (values.length === 0) return 0
      const encoded = values.map((v) => ev(ctx, v))
      return run(ctx, (c) => (c.rpush as (...a: unknown[]) => Promise<number>)(k, ...encoded))
    },

    async lPop<T>(key: string): Promise<T | null> {
      const k = ek(ctx, key)
      const raw = await run(ctx, (c) => c.lpop(k) as Promise<string | null>)
      return dv<T>(ctx, raw)
    },

    async rPop<T>(key: string): Promise<T | null> {
      const k = ek(ctx, key)
      const raw = await run(ctx, (c) => c.rpop(k) as Promise<string | null>)
      return dv<T>(ctx, raw)
    },

    async lLen(key: string): Promise<number> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.llen(k), { retryable: true })
    },

    async lRange<T>(key: string, start: number, stop: number): Promise<T[]> {
      const k = ek(ctx, key)
      const rows = await run(ctx, (c) => c.lrange(k, start, stop) as Promise<string[]>, {
        retryable: true,
      })
      return rows.map((r) => dv<T>(ctx, r)) as T[]
    },

    async lIndex<T>(key: string, index: number): Promise<T | null> {
      const k = ek(ctx, key)
      const raw = await run(ctx, (c) => c.lindex(k, index) as Promise<string | null>, {
        retryable: true,
      })
      return dv<T>(ctx, raw)
    },

    async lSet(key: string, index: number, value: unknown): Promise<void> {
      const k = ek(ctx, key)
      await run(ctx, (c) => c.lset(k, index, ev(ctx, value)))
    },

    async lRem(key: string, count: number, value: unknown): Promise<number> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.lrem(k, count, ev(ctx, value)))
    },

    async lTrim(key: string, start: number, stop: number): Promise<void> {
      const k = ek(ctx, key)
      await run(ctx, (c) => c.ltrim(k, start, stop))
    },

    /**
     * Blocking pop with a dedicated connection so it never head-of-line-blocks
     * ordinary commands. `timeoutSec` of 0 blocks indefinitely.
     */
    async blPop<T>(key: string, timeoutSec = 0): Promise<[string, T] | null> {
      const k = ek(ctx, key)
      const res = await runDedicated(
        ctx,
        'blocking',
        (c) => c.blpop(k, timeoutSec) as Promise<[string, string] | null>,
        { timeoutMs: timeoutSec > 0 ? (timeoutSec + 5) * 1000 : 0 },
      )
      return res ? [res[0], dv<T>(ctx, res[1]) as T] : null
    },

    async brPop<T>(key: string, timeoutSec = 0): Promise<[string, T] | null> {
      const k = ek(ctx, key)
      const res = await runDedicated(
        ctx,
        'blocking',
        (c) => c.brpop(k, timeoutSec) as Promise<[string, string] | null>,
        { timeoutMs: timeoutSec > 0 ? (timeoutSec + 5) * 1000 : 0 },
      )
      return res ? [res[0], dv<T>(ctx, res[1]) as T] : null
    },
  }
}

export type ListOps = ReturnType<typeof listOps>
