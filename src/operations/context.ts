import type { Codec } from '../codec/index.js'
import type { RedisClient } from '../connection/factory.js'
import type { ConnectionPool } from '../connection/pool.js'
import type { SubmitOptions, TaskExecutor } from '../executor/task-executor.js'

/** Shared dependencies threaded through every operation module. */
export interface OpsContext {
  pool: ConnectionPool
  codec: Codec
  executor: TaskExecutor
}

/**
 * Run a single Redis command under executor admission control, borrowing and
 * releasing a pooled connection. `retryable` should only be set for idempotent
 * commands.
 *
 * The executor's `AbortSignal` (fired on timeout) is wired to the lease: on
 * abort the connection is force-destroyed so the in-flight command rejects and
 * the (possibly hung) connection is never returned to the pool. Without this a
 * timed-out command against an unreachable Redis would leak its connection and
 * eventually exhaust the pool.
 */
export function run<T>(
  ctx: OpsContext,
  cmd: (client: RedisClient) => Promise<T>,
  opts?: SubmitOptions,
): Promise<T> {
  return ctx.executor.submit(async (signal) => {
    const lease = await ctx.pool.acquire()
    let aborted = false
    const onAbort = () => {
      aborted = true
      lease.destroy()
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await cmd(lease.client)
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (!aborted) lease.release()
    }
  }, opts)
}

/** Like {@link run} but borrows a dedicated connection (blocking / pubsub). */
export function runDedicated<T>(
  ctx: OpsContext,
  kind: 'blocking' | 'pubsub',
  cmd: (client: RedisClient) => Promise<T>,
  opts?: SubmitOptions,
): Promise<T> {
  return ctx.executor.submit(async (signal) => {
    const lease = await ctx.pool.acquire(kind)
    let aborted = false
    const onAbort = () => {
      aborted = true
      lease.destroy()
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await cmd(lease.client)
    } finally {
      signal.removeEventListener('abort', onAbort)
      if (!aborted) lease.release()
    }
  }, opts)
}

/** Encode an outbound key (applies prefix). */
export function ek(ctx: OpsContext, key: string): string {
  return ctx.codec.keys.serialize(key)
}

/** Decode an inbound key (strips prefix). */
export function dk(ctx: OpsContext, raw: string): string {
  return ctx.codec.keys.deserialize(raw)
}

/** Serialize an outbound value. */
export function ev(ctx: OpsContext, value: unknown): string | Buffer {
  return ctx.codec.values.serialize(value)
}

/** Deserialize an inbound value. */
export function dv<T>(ctx: OpsContext, raw: string | Buffer | null): T | null {
  return ctx.codec.values.deserialize<T>(raw)
}
