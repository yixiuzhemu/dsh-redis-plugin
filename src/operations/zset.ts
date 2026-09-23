import { dv, ek, ev, run, type OpsContext } from './context.js'

type AnyCall = (...args: unknown[]) => Promise<unknown>

export interface ScoredValue<T> {
  value: T
  score: number
}

/** Sorted-set operations — mirrors the "zset相关操作" group of `RedisUtils<T>`. */
export function zsetOps(ctx: OpsContext) {
  function toScored<T>(flat: string[]): ScoredValue<T>[] {
    const out: ScoredValue<T>[] = []
    for (let i = 0; i < flat.length; i += 2) {
      const raw = flat[i]
      const score = flat[i + 1]
      out.push({ value: dv<T>(ctx, raw ?? null) as T, score: Number(score ?? 0) })
    }
    return out
  }

  return {
    /** Add one or more `{ score, value }` members. */
    async zAdd(key: string, ...items: Array<{ score: number; value: unknown }>): Promise<number> {
      const k = ek(ctx, key)
      if (items.length === 0) return 0
      const flat: Array<string | Buffer | number> = []
      for (const it of items) flat.push(it.score, ev(ctx, it.value))
      return run(ctx, (c) => (c.zadd as AnyCall)(k, ...flat) as Promise<number>)
    },

    async zRem(key: string, ...values: unknown[]): Promise<number> {
      const k = ek(ctx, key)
      if (values.length === 0) return 0
      const encoded = values.map((v) => ev(ctx, v))
      return run(ctx, (c) => (c.zrem as AnyCall)(k, ...encoded) as Promise<number>)
    },

    async zScore(key: string, value: unknown): Promise<number | null> {
      const k = ek(ctx, key)
      const raw = await run(ctx, (c) => c.zscore(k, ev(ctx, value)) as Promise<string | null>, {
        retryable: true,
      })
      return raw === null ? null : Number(raw)
    },

    async zCard(key: string): Promise<number> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.zcard(k), { retryable: true })
    },

    async zCount(key: string, min: number | string, max: number | string): Promise<number> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.zcount(k, min as number, max as number), { retryable: true })
    },

    async zRank(key: string, value: unknown): Promise<number | null> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.zrank(k, ev(ctx, value)), { retryable: true })
    },

    async zIncrBy(key: string, increment: number, value: unknown): Promise<number> {
      const k = ek(ctx, key)
      const raw = await run(ctx, (c) => c.zincrby(k, increment, ev(ctx, value)))
      return Number(raw)
    },

    async zRange<T>(key: string, start: number, stop: number): Promise<T[]> {
      const k = ek(ctx, key)
      const rows = await run(ctx, (c) => c.zrange(k, start, stop) as Promise<string[]>, {
        retryable: true,
      })
      return rows.map((r) => dv<T>(ctx, r)) as T[]
    },

    async zRangeWithScores<T>(key: string, start: number, stop: number): Promise<ScoredValue<T>[]> {
      const k = ek(ctx, key)
      const flat = await run(
        ctx,
        (c) => c.zrange(k, start, stop, 'WITHSCORES') as unknown as Promise<string[]>,
        { retryable: true },
      )
      return toScored<T>(flat)
    },

    async zRangeByScore<T>(
      key: string,
      min: number | string,
      max: number | string,
    ): Promise<T[]> {
      const k = ek(ctx, key)
      const rows = await run(
        ctx,
        (c) => c.zrangebyscore(k, min as number, max as number) as Promise<string[]>,
        { retryable: true },
      )
      return rows.map((r) => dv<T>(ctx, r)) as T[]
    },

    async zRevRange<T>(key: string, start: number, stop: number): Promise<T[]> {
      const k = ek(ctx, key)
      const rows = await run(ctx, (c) => c.zrevrange(k, start, stop) as Promise<string[]>, {
        retryable: true,
      })
      return rows.map((r) => dv<T>(ctx, r)) as T[]
    },
  }
}

export type ZSetOps = ReturnType<typeof zsetOps>
