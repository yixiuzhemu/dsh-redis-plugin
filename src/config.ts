import z from '@deepseek-ai/schemastery'
import type { RejectPolicy, Topology, ValueEncoding } from './types.js'

export interface TlsOptions {
  ca?: string
  cert?: string
  key?: string
  rejectUnauthorized?: boolean
  [k: string]: unknown
}

export interface ConnectionConfig {
  /** Only `standalone` is implemented; others are reserved extension points. */
  topology: Topology
  url?: string
  host?: string
  port?: number
  password?: string
  username?: string
  db?: number
  tls?: boolean | TlsOptions
  /** Reserved (not implemented in this milestone). */
  sentinel?: { nodes: string[]; master: string }
  /** Reserved (not implemented in this milestone). */
  cluster?: { nodes: string[] }
}

export interface PoolConfig {
  min: number
  max: number
  idleTimeoutMs: number
  healthCheckMs: number
}

export interface ExecutorConfig {
  coreSize: number
  maxSize: number
  queueCapacity: number
  keepAliveMs: number
  timeoutMs: number
  rejectPolicy: RejectPolicy
  retry: { maxAttempts: number; backoffMs: number }
}

export interface CodecConfig {
  keyPrefix?: string
  value: ValueEncoding
  typeHint?: boolean
  offloadThresholdBytes?: number
}

export interface LockConfig {
  defaultTtlMs: number
  watchdogIntervalMs: number
  renewAheadMs: number
  releaseOnDispose: boolean
}

export interface ToolsConfig {
  enabled: boolean
  allowDestructive: boolean
}

export interface Config {
  connection: ConnectionConfig
  pool: PoolConfig
  executor: ExecutorConfig
  codec: CodecConfig
  lock: LockConfig
  tools: ToolsConfig
}

/** Deep defaults so a bare `- name: dsh-redis-plugin` line still works. */
export const defaultConfig: Config = {
  connection: { topology: 'standalone', host: '127.0.0.1', port: 6379, db: 0 },
  pool: { min: 2, max: 16, idleTimeoutMs: 30_000, healthCheckMs: 15_000 },
  executor: {
    coreSize: 8,
    maxSize: 32,
    queueCapacity: 1024,
    keepAliveMs: 60_000,
    timeoutMs: 3_000,
    rejectPolicy: 'abort',
    retry: { maxAttempts: 3, backoffMs: 200 },
  },
  codec: { value: 'json', typeHint: false, offloadThresholdBytes: 1_048_576 },
  lock: { defaultTtlMs: 30_000, watchdogIntervalMs: 1_000, renewAheadMs: 10_000, releaseOnDispose: false },
  tools: { enabled: true, allowDestructive: false },
}

/**
 * Merge a partial (possibly deeply nested) user config over {@link defaultConfig}.
 * `undefined` values in the input are ignored so patch layers compose cleanly.
 */
export function resolveConfig(input: DeepPartial<Config> = {}): Config {
  return {
    connection: { ...defaultConfig.connection, ...compact(input.connection) },
    pool: { ...defaultConfig.pool, ...compact(input.pool) },
    executor: {
      ...defaultConfig.executor,
      ...compact(input.executor),
      retry: { ...defaultConfig.executor.retry, ...compact(input.executor?.retry) },
    },
    codec: { ...defaultConfig.codec, ...compact(input.codec) },
    lock: { ...defaultConfig.lock, ...compact(input.lock) },
    tools: { ...defaultConfig.tools, ...compact(input.tools) },
  }
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

function compact<T extends object>(obj?: T): Partial<T> {
  if (!obj) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out as Partial<T>
}

/**
 * Deployment-time schema (schemastery). Loaded by the Cordis loader to
 * validate the `config:` block of this plugin's line in `cordis.patch.yml`.
 */
export const Config = z.object({
  connection: z
    .object({
      topology: z.enum(['standalone', 'sentinel', 'cluster']).default('standalone'),
      url: z.string().optional(),
      host: z.string().optional(),
      port: z.number().optional(),
      password: z.string().optional(),
      username: z.string().optional(),
      db: z.number().optional(),
      tls: z.any().optional(),
      sentinel: z.any().optional(),
      cluster: z.any().optional(),
    })
    .default({}),
  pool: z
    .object({
      min: z.number().default(defaultConfig.pool.min),
      max: z.number().default(defaultConfig.pool.max),
      idleTimeoutMs: z.number().default(defaultConfig.pool.idleTimeoutMs),
      healthCheckMs: z.number().default(defaultConfig.pool.healthCheckMs),
    })
    .default({}),
  executor: z
    .object({
      coreSize: z.number().default(defaultConfig.executor.coreSize),
      maxSize: z.number().default(defaultConfig.executor.maxSize),
      queueCapacity: z.number().default(defaultConfig.executor.queueCapacity),
      keepAliveMs: z.number().default(defaultConfig.executor.keepAliveMs),
      timeoutMs: z.number().default(defaultConfig.executor.timeoutMs),
      rejectPolicy: z.enum(['abort', 'discardOldest', 'callerRuns']).default('abort'),
      retry: z
        .object({
          maxAttempts: z.number().default(defaultConfig.executor.retry.maxAttempts),
          backoffMs: z.number().default(defaultConfig.executor.retry.backoffMs),
        })
        .default({}),
    })
    .default({}),
  codec: z
    .object({
      keyPrefix: z.string().optional(),
      value: z.enum(['json', 'string', 'raw']).default('json'),
      typeHint: z.boolean().default(false),
      offloadThresholdBytes: z.number().default(defaultConfig.codec.offloadThresholdBytes!),
    })
    .default({}),
  lock: z
    .object({
      defaultTtlMs: z.number().default(defaultConfig.lock.defaultTtlMs),
      watchdogIntervalMs: z.number().default(defaultConfig.lock.watchdogIntervalMs),
      renewAheadMs: z.number().default(defaultConfig.lock.renewAheadMs),
      releaseOnDispose: z.boolean().default(false),
    })
    .default({}),
  tools: z
    .object({
      enabled: z.boolean().default(true),
      allowDestructive: z.boolean().default(false),
    })
    .default({}),
})
