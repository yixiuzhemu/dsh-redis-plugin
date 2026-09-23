import type { ScanOptions, TimeUnit } from '../types.js'
import { toMillis } from '../types.js'
import { dk, dv, ek, run, type OpsContext } from './context.js'

/**
 * Key-space operations — mirrors the "key相关操作" group of `RedisUtils<T>`.
 * `keys()` is intentionally omitted; use {@link scan} instead.
 */
export function keyOps(ctx: OpsContext) {
  /**
   * Cursor-based key iteration (replaces the deprecated `keys()`).
   * Yields keys with the configured prefix stripped.
   */
  async function* scanIter(options: ScanOptions = {}): AsyncIterableIterator<string> {
    const match = options.match ? ctx.codec.keys.serializePattern(options.match) : undefined
    const count = options.count ?? 100
    let cursor = '0'
    do {
      const args: (string | number)[] = [cursor]
      if (match) args.push('MATCH', match)
      args.push('COUNT', count)
      if (options.type) args.push('TYPE', options.type)
      const [next, keys] = await run(
        ctx,
        (c) => (c.scan as (...a: unknown[]) => Promise<[string, string[]]>)(...args),
        { retryable: true },
      )
      cursor = next
      for (const k of keys) yield dk(ctx, k)
    } while (cursor !== '0')
  }

  async function scanKeys(options: ScanOptions = {}): Promise<string[]> {
    const out: string[] = []
    for await (const k of scanIter(options)) out.push(k)
    return out
  }

  return {
    async del(key: string | string[]): Promise<number> {
      const keys = (Array.isArray(key) ? key : [key]).map((k) => ek(ctx, k))
      if (keys.length === 0) return 0
      return run(ctx, (c) => c.del(...keys), { retryable: true })
    },

    async exists(key: string): Promise<boolean> {
      const k = ek(ctx, key)
      const n = await run(ctx, (c) => c.exists(k), { retryable: true })
      return n > 0
    },

    async expire(key: string, ttl: number, unit: TimeUnit = 's'): Promise<boolean> {
      const k = ek(ctx, key)
      const ms = toMillis(ttl, unit)
      const n = await run(ctx, (c) => c.pexpire(k, ms), { retryable: true })
      return n === 1
    },

    async expireAt(key: string, date: Date): Promise<boolean> {
      const k = ek(ctx, key)
      const n = await run(ctx, (c) => c.pexpireat(k, date.getTime()), { retryable: true })
      return n === 1
    },

    async persist(key: string): Promise<boolean> {
      const k = ek(ctx, key)
      const n = await run(ctx, (c) => c.persist(k), { retryable: true })
      return n === 1
    },

    /** Remaining TTL. Returns milliseconds (`unit='ms'`) or seconds by default. */
    async ttl(key: string, unit: TimeUnit = 's'): Promise<number> {
      const k = ek(ctx, key)
      const ms = await run(ctx, (c) => c.pttl(k), { retryable: true })
      if (unit === 'ms') return ms
      return ms < 0 ? ms : Math.round(ms / toMillis(1, unit))
    },

    async type(key: string): Promise<string> {
      const k = ek(ctx, key)
      return run(ctx, (c) => c.type(k), { retryable: true })
    },

    async rename(oldKey: string, newKey: string): Promise<void> {
      const a = ek(ctx, oldKey)
      const b = ek(ctx, newKey)
      await run(ctx, (c) => c.rename(a, b))
    },

    async renameIfAbsent(oldKey: string, newKey: string): Promise<boolean> {
      const a = ek(ctx, oldKey)
      const b = ek(ctx, newKey)
      const n = await run(ctx, (c) => c.renamenx(a, b), { retryable: true })
      return n === 1
    },

    async randomKey(): Promise<string | null> {
      const raw = await run(ctx, (c) => c.randomkey(), { retryable: true })
      return raw ? dk(ctx, raw) : null
    },

    /** Cursor-based key iteration (replaces the deprecated `keys()`). */
    scan: scanIter,

    /** Collect all keys matching a prefix/pattern into an array. */
    scanKeys,

    /**
     * Batch-fetch values for every key under a prefix using a single pipeline
     * (mirrors `RedisUtils.batchSearch`). The prefix is matched with `*`.
     */
    async batchSearch<T>(prefix: string): Promise<Record<string, T>> {
      const keys = await scanKeys({ match: `${prefix}*` })
      if (keys.length === 0) return {}
      const encoded = keys.map((k) => ek(ctx, k))
      const rows = await run(
        ctx,
        (c) => c.mget(...encoded) as Promise<Array<string | null>>,
        { retryable: true },
      )
      const result: Record<string, T> = {}
      keys.forEach((k, i) => {
        const v = dv<T>(ctx, rows[i] ?? null)
        if (v !== null) result[k] = v
      })
      return result
    },
  }
}

export type KeyOps = ReturnType<typeof keyOps>
