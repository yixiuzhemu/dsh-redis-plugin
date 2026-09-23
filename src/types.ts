/**
 * Shared, framework-agnostic types for dsh-redis-plugin.
 */

/** Time unit for TTL / expiry APIs. Internally normalized to milliseconds. */
export type TimeUnit = 'ms' | 's' | 'm' | 'h' | 'd'

/** Connection role, used by the pool to isolate blocking / pub-sub traffic. */
export type ConnKind = 'default' | 'blocking' | 'pubsub'

/** Topology selector. Only `standalone` is implemented in this milestone. */
export type Topology = 'standalone' | 'sentinel' | 'cluster'

/** Value serialization strategy. */
export type ValueEncoding = 'json' | 'string' | 'raw'

/** Rejection policy when the executor queue is saturated. */
export type RejectPolicy = 'abort' | 'discardOldest' | 'callerRuns'

export interface PoolStats {
  active: number
  idle: number
  waiting: number
  created: number
  destroyed: number
}

export interface ExecutorMetrics {
  active: number
  queued: number
  completed: number
  rejected: number
  timedOut: number
  retried: number
}

/** Options for `set`. Mirrors Redis `SET key value [EX|PX] [NX|XX]`. */
export interface SetOptions {
  /** Expire time in seconds. */
  ex?: number
  /** Expire time in milliseconds. */
  px?: number
  /** Only set if key does not exist. */
  nx?: boolean
  /** Only set if key already exists. */
  xx?: boolean
}

/** Options for cursor-based `scan`. */
export interface ScanOptions {
  /** Glob-style match pattern, e.g. `user:*`. */
  match?: string
  /** Hint for the number of keys returned per SCAN iteration. */
  count?: number
  /** Optional Redis type filter (SCAN `TYPE` argument, Redis >= 6.0). */
  type?: string
}

/** Opaque token proving ownership of a distributed lock. */
export interface LockToken {
  readonly key: string
  readonly value: string
  readonly ttlMs: number
  readonly acquiredAt: number
}

export interface WithLockOptions {
  /** Lock TTL; defaults to `lock.defaultTtlMs`. */
  ttl?: number
  unit?: TimeUnit
  /** Retry interval in ms when the lock is contended. */
  retryInterval?: number
  /** Maximum number of retries when the lock is contended. */
  retryCount?: number
  /** Invoked when renewal fails / the lock is lost to another owner. */
  onLost?: (key: string) => void
}

/** A minimal pipeline handle exposing the queued command surface. */
export interface RedisPipeline {
  get(key: string): RedisPipeline
  set(key: string, value: unknown, opts?: SetOptions): RedisPipeline
  del(key: string | string[]): RedisPipeline
  exec(): Promise<unknown[]>
}

/**
 * An atomic MULTI/EXEC transaction handle. Queued commands are applied
 * back-to-back on the server without another client's command interleaving.
 * Like {@link RedisPipeline}, `exec()` resolves to the raw command outputs.
 */
export interface RedisTransaction {
  get(key: string): RedisTransaction
  set(key: string, value: unknown, opts?: SetOptions): RedisTransaction
  del(key: string | string[]): RedisTransaction
  exec(): Promise<unknown[]>
}

/** Generic error carrying an optional cause for diagnostics. */
export class RedisPluginError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'RedisPluginError'
    if (options?.cause !== undefined) {
      ;(this as { cause?: unknown }).cause = options.cause
    }
  }
}

/** Milliseconds per {@link TimeUnit}. */
const UNIT_MS: Record<TimeUnit, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

/**
 * Normalize a duration to milliseconds.
 * Mirrors `RedisLockUtils.convertTimeUnit` from the Java reference.
 */
export function toMillis(duration: number, unit: TimeUnit = 'ms'): number {
  const factor = UNIT_MS[unit]
  return Math.round(duration * factor)
}
