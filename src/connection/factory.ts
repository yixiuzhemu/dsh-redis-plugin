import { Redis, type RedisOptions } from 'ioredis'
import type { ConnectionConfig } from '../config.js'
import { RedisPluginError, type Topology } from '../types.js'

/** The concrete client type used across the plugin. */
export type RedisClient = Redis

/** Factory that creates raw ioredis connections for a given topology. */
export interface ConnectionFactory {
  readonly topology: Topology
  /** Create (and begin connecting) a single client. */
  create(): RedisClient
}

/** Optional client constructor override — used by tests (ioredis-mock). */
export type ClientCtor = new (options: RedisOptions | string) => RedisClient

export function createConnectionFactory(config: ConnectionConfig, ctor?: ClientCtor): ConnectionFactory {
  const RedisCtor: ClientCtor = ctor ?? (Redis as unknown as ClientCtor)

  switch (config.topology) {
    case 'standalone':
      return {
        topology: 'standalone',
        create: () => new RedisCtor(buildStandaloneOptions(config)),
      }
    case 'sentinel':
    case 'cluster':
      // Reserved extension points. Fail loud rather than silently mis-connect.
      throw new RedisPluginError(
        `Topology "${config.topology}" is not implemented in this milestone; only "standalone" is supported. ` +
          `See DESIGN.md §5.1 for the planned extension seam.`,
      )
    default:
      throw new RedisPluginError(`Unknown topology: ${String(config.topology)}`)
  }
}

function buildStandaloneOptions(config: ConnectionConfig): RedisOptions | string {
  if (config.url) return config.url

  const options: RedisOptions = {
    host: config.host ?? '127.0.0.1',
    port: config.port ?? 6379,
    db: config.db ?? 0,
    // Let the executor own timeout/retry semantics; keep the client predictable.
    lazyConnect: false,
    enableOfflineQueue: true,
    maxRetriesPerRequest: null,
    keepAlive: 10_000,
  }
  if (config.password !== undefined) options.password = config.password
  if (config.username !== undefined) options.username = config.username
  if (config.tls === true) options.tls = {}
  else if (config.tls && typeof config.tls === 'object') options.tls = config.tls
  return options
}
