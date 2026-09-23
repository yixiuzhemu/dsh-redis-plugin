import { dv, ek, ev, run, type OpsContext } from './context.js'

/** Set operations — mirrors the "set相关操作" group of `RedisUtils<T>`. */
export function setOps(ctx: OpsContext) {
  return {
    async sAdd(key: string, ...values: unknown[]): Promise<number> {
      const k = ek(ctx, key)
      if (values.length === 0) return 0
      const encoded = values.map((v) => ev(ctx, v))
      return run(ctx, (c) => (c.sadd as (...a: unknown[]) => Promise<number>)(k, ...encoded))
    },

    async sRem(key: string, ...values: unknown[]): Promise<number> {
      const k = ek(ctx, key)
      if (values.length === 0) return 0
      const encoded = values.map((v) => ev(ctx, v))
      return run(ctx, (c) => (c.srem as (...a: unknown[]) => Promise<number>)(k, ...encoded))
    },

    async sMembers<T>(key: string): Promise<T[]> {
      const k = ek(ctx, key)
      const rows = await run(ctx, (c) => c.smembers(k) as Promise<string[]>, { retryable: true })
      return rows.map((r) => dv<T>(ctx, r)) as T[]
    },

    async sIsMember(key: string, value: unknown): Promise<boolean> {
      const k = ek(ctx, key)
      const n = await run(ctx, (c) => c.sismember(k, ev(ctx, value)), { retryable: true })
      return n === 1
    },

    async sCard(key: string): Promise<number> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.scard(k), { retryable: true })
    },

    async sPop<T>(key: string, count?: number): Promise<T | T[] | null> {
      const k = ek(ctx, key)
      if (count === undefined) {
        const raw = await run(ctx, (c) => c.spop(k) as Promise<string | null>)
        return raw === null ? null : (dv<T>(ctx, raw) as T)
      }
      const rows = await run(ctx, (c) => c.spop(k, count) as unknown as Promise<string[]>)
      return rows.map((r) => dv<T>(ctx, r)) as T[]
    },

    async sRandMember<T>(key: string, count?: number): Promise<T | T[] | null> {
      const k = ek(ctx, key)
      if (count === undefined) {
        const raw = await run(ctx, (c) => c.srandmember(k) as Promise<string | null>, {
          retryable: true,
        })
        return raw === null ? null : (dv<T>(ctx, raw) as T)
      }
      const rows = await run(ctx, (c) => c.srandmember(k, count) as unknown as Promise<string[]>, {
        retryable: true,
      })
      return rows.map((r) => dv<T>(ctx, r)) as T[]
    },

    async sInter<T>(...keys: string[]): Promise<T[]> {
      const encoded = keys.map((k) => ek(ctx, k))
      if (encoded.length === 0) return []
      const rows = await run(
        ctx,
        (c) => (c.sinter as (...a: string[]) => Promise<string[]>)(...encoded),
        { retryable: true },
      )
      return rows.map((r) => dv<T>(ctx, r)) as T[]
    },

    async sUnion<T>(...keys: string[]): Promise<T[]> {
      const encoded = keys.map((k) => ek(ctx, k))
      if (encoded.length === 0) return []
      const rows = await run(
        ctx,
        (c) => (c.sunion as (...a: string[]) => Promise<string[]>)(...encoded),
        { retryable: true },
      )
      return rows.map((r) => dv<T>(ctx, r)) as T[]
    },

    async sDiff<T>(...keys: string[]): Promise<T[]> {
      const encoded = keys.map((k) => ek(ctx, k))
      if (encoded.length === 0) return []
      const rows = await run(
        ctx,
        (c) => (c.sdiff as (...a: string[]) => Promise<string[]>)(...encoded),
        { retryable: true },
      )
      return rows.map((r) => dv<T>(ctx, r)) as T[]
    },
  }
}

export type SetOps = ReturnType<typeof setOps>
