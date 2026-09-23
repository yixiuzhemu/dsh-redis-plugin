import type { Config } from './config.js'
import { resolveConfig, type DeepPartial } from './config.js'
import { createCodec } from './codec/index.js'
import { createConnectionFactory, type ClientCtor } from './connection/factory.js'
import { ConnectionPool } from './connection/pool.js'
import { TaskExecutor } from './executor/task-executor.js'
import { createOperations, type Operations } from './operations/index.js'
import type { OpsContext } from './operations/context.js'
import { RedisLock } from './lock/redis-lock.js'
import type { WatchdogLogger } from './lock/watchdog.js'
import type { ExecutorMetrics, PoolStats } from './types.js'

/**
 * The public Redis facade exposed on `ctx.redis` and consumable as a library.
 * It is the flat merge of every data-type operation plus lock/governance.
 */
export interface RedisService extends Operations {
  readonly lock: RedisLock
  /** Warm up the connection pool. Idempotent; safe to fire-and-forget. */
  start(): Promise<void>
  /** Pool + executor telemetry for diagnostics / dashboards. */
  stats(): { pool: PoolStats; executor: ExecutorMetrics }
  /** Graceful shutdown: stop watchdog, drain executor, quit connections. */
  dispose(): Promise<void>
}

export interface CreateRedisOptions {
  /** Override the ioredis constructor (used by tests with ioredis-mock). */
  clientCtor?: ClientCtor
  /** Logger forwarded to the lock watchdog. */
  logger?: WatchdogLogger
}

/**
 * Build a fully-wired {@link RedisService} from (partial) config.
 * Framework-agnostic: no dependency on Cordis, so it can be unit-tested and
 * reused as a plain library.
 */
export function createRedis(input: DeepPartial<Config> = {}, options: CreateRedisOptions = {}): RedisService {
  const config: Config = resolveConfig(input)

  const codec = createCodec(config.codec)
  const executor = new TaskExecutor(config.executor)
  const factory = createConnectionFactory(config.connection, options.clientCtor)
  const pool = new ConnectionPool(factory, config.pool)

  const opsCtx: OpsContext = { pool, codec, executor }
  const operations = createOperations(opsCtx)
  const lock = new RedisLock(opsCtx, config.lock, options.logger)

  let started = false

  const service: RedisService = {
    ...operations,
    lock,
    async start() {
      if (started) return
      started = true
      await pool.start()
    },
    stats() {
      return { pool: pool.stats(), executor: executor.metrics() }
    },
    async dispose() {
      await lock.dispose()
      await executor.dispose()
      await pool.dispose()
    },
  }
  return service
}
