/**
 * Framework-agnostic public surface. Importable directly:
 *   import { createRedis } from 'dsh-redis-plugin/core'
 *
 * This module has NO dependency on the dsh/Cordis host, so the Redis core can be
 * unit-tested and reused as a plain library.
 */
export { createRedis } from './service.js'
export type { RedisService, CreateRedisOptions } from './service.js'

export {
  Config as ConfigSchema,
  defaultConfig,
  resolveConfig,
} from './config.js'
export type {
  Config,
  ConnectionConfig,
  PoolConfig,
  ExecutorConfig,
  CodecConfig,
  LockConfig,
  ToolsConfig,
  DeepPartial,
} from './config.js'

export * from './types.js'
export { createCodec } from './codec/index.js'
export type { Codec } from './codec/index.js'
export { TaskExecutor } from './executor/task-executor.js'
export { ConnectionPool } from './connection/pool.js'
export { RedisLock } from './lock/redis-lock.js'
