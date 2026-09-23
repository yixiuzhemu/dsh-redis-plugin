import type { RedisClient } from '../connection/factory.js'
import type { RedisPipeline, RedisTransaction, SetOptions } from '../types.js'
import { ek, ev, run, type OpsContext } from './context.js'

// Local structural type to avoid importing ioredis's ChainableCommand type.
// Both `pipeline()` and `multi()` return a chainable with this shape.
type Chain = {
  get(key: string): unknown
  set(...args: unknown[]): unknown
  del(...args: unknown[]): unknown
  exec(): Promise<Array<[Error | null, unknown]> | null>
}

/** The command surface shared by {@link RedisPipeline} and {@link RedisTransaction}. */
interface Chainable {
  get(key: string): Chainable
  set(key: string, value: unknown, opts?: SetOptions): Chainable
  del(key: string | string[]): Chainable
  exec(): Promise<unknown[]>
}

/**
 * Queue commands and flush them over a single connection round-trip. `begin`
 * selects the underlying ioredis chainable: `pipeline()` for a plain batch,
 * `multi()` for an atomic MULTI/EXEC transaction.
 */
function buildChainable(ctx: OpsContext, begin: (c: RedisClient) => Chain): Chainable {
  const queue: Array<(p: Chain) => void> = []

  const api: Chainable = {
    get(key: string) {
      queue.push((p) => p.get(ek(ctx, key)))
      return api
    },
    set(key: string, value: unknown, opts?: SetOptions) {
      const args: unknown[] = [ek(ctx, key), ev(ctx, value)]
      if (opts?.ex !== undefined) args.push('EX', opts.ex)
      else if (opts?.px !== undefined) args.push('PX', opts.px)
      if (opts?.nx) args.push('NX')
      if (opts?.xx) args.push('XX')
      queue.push((p) => p.set(...args))
      return api
    },
    del(key: string | string[]) {
      const keys = (Array.isArray(key) ? key : [key]).map((k) => ek(ctx, k))
      queue.push((p) => p.del(...keys))
      return api
    },
    async exec() {
      return run(ctx, async (c) => {
        const p = begin(c)
        for (const enqueue of queue) enqueue(p)
        const results = await p.exec()
        if (!results) return []
        return results.map(([err, val]) => {
          if (err) throw err
          return val
        })
      })
    },
  }
  return api
}

/**
 * Build a pipelined batch executed over a single connection round-trip.
 * Mirrors `RedisTemplate.executePipelined` used by `RedisUtils.batchSearch`.
 */
export function createPipeline(ctx: OpsContext): RedisPipeline {
  return buildChainable(ctx, (c) => c.pipeline() as unknown as Chain) as unknown as RedisPipeline
}

/**
 * Build an atomic MULTI/EXEC transaction. Queued commands are applied
 * back-to-back on the server without another client's command interleaving.
 */
export function createTransaction(ctx: OpsContext): RedisTransaction {
  return buildChainable(ctx, (c) => c.multi() as unknown as Chain) as unknown as RedisTransaction
}

/**
 * Run a Lua script atomically (used by the distributed lock's unlock/renew).
 * `numKeys` mirrors Redis `EVAL script numkeys key... arg...`.
 */
export function evalScript<T>(
  ctx: OpsContext,
  script: string,
  keys: string[],
  args: Array<string | number>,
): Promise<T> {
  return run(
    ctx,
    (c) =>
      (c as unknown as {
        eval: (...a: unknown[]) => Promise<unknown>
      }).eval(script, keys.length, ...keys, ...args) as Promise<T>,
    { retryable: false },
  )
}
