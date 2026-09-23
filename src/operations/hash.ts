import { dv, ek, ev, run, type OpsContext } from './context.js'

/** Hash operations — mirrors the "hash相关操作" group of `RedisUtils<T>`. */
export function hashOps(ctx: OpsContext) {
  return {
    async hGet<T>(key: string, field: string): Promise<T | null> {
      const k = ek(ctx, key)
      const raw = await run(ctx, (c) => c.hget(k, field) as Promise<string | null>, { retryable: true })
      return dv<T>(ctx, raw)
    },

    async hSet(key: string, field: string, value: unknown): Promise<number> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.hset(k, field, ev(ctx, value)))
    },

    async hSetAll(key: string, map: Record<string, unknown>): Promise<void> {
      const k = ek(ctx, key)
      const flat: Array<string | Buffer> = []
      for (const [f, v] of Object.entries(map)) flat.push(f, ev(ctx, v))
      if (flat.length === 0) return
      await run(
        ctx,
        (c) => (c.hset as (...a: unknown[]) => Promise<unknown>)(k, ...flat) as Promise<unknown>,
      )
    },

    async hDel(key: string, ...fields: string[]): Promise<number> {
      const k = ek(ctx, key)
      if (fields.length === 0) return 0
      return run(ctx, (c) => c.hdel(k, ...fields))
    },

    async hExists(key: string, field: string): Promise<boolean> {
      const k = ek(ctx, key)
      const n = await run(ctx, (c) => c.hexists(k, field), { retryable: true })
      return n === 1
    },

    async hKeys(key: string): Promise<string[]> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.hkeys(k), { retryable: true })
    },

    async hVals<T>(key: string): Promise<T[]> {
      const k = ek(ctx, key)
      const rows = await run(ctx, (c) => c.hvals(k) as Promise<string[]>, { retryable: true })
      return rows.map((r) => dv<T>(ctx, r)) as T[]
    },

    async hGetAll<T>(key: string): Promise<Record<string, T>> {
      const k = ek(ctx, key)
      const raw = await run(ctx, (c) => c.hgetall(k) as Promise<Record<string, string>>, {
        retryable: true,
      })
      const out: Record<string, T> = {}
      for (const [f, v] of Object.entries(raw)) {
        const parsed = dv<T>(ctx, v)
        if (parsed !== null) out[f] = parsed
      }
      return out
    },

    async hLen(key: string): Promise<number> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.hlen(k), { retryable: true })
    },

    async hMGet<T>(key: string, ...fields: string[]): Promise<Array<T | null>> {
      const k = ek(ctx, key)
      if (fields.length === 0) return []
      const rows = await run(ctx, (c) => c.hmget(k, ...fields) as Promise<Array<string | null>>, {
        retryable: true,
      })
      return rows.map((r) => dv<T>(ctx, r))
    },

    async hIncrBy(key: string, field: string, increment = 1): Promise<number> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.hincrby(k, field, increment))
    },

    async hIncrByFloat(key: string, field: string, increment: number): Promise<number> {
      const k = ek(ctx, key)
      const res = await run(ctx, (c) => c.hincrbyfloat(k, field, increment))
      return Number(res)
    },
  }
}

export type HashOps = ReturnType<typeof hashOps>
