import type { PoolConfig } from '../config.js'
import { RedisPluginError, type ConnKind, type PoolStats } from '../types.js'
import type { ConnectionFactory, RedisClient } from './factory.js'

/** A leased connection together with its release handle. */
export interface Lease {
  readonly client: RedisClient
  readonly kind: ConnKind
  /** Return the connection to the pool for reuse. */
  release(): void
  /**
   * Forcibly drop the connection. Used when a command is aborted / times out:
   * disconnects immediately (so the in-flight command rejects) and never hands
   * the connection back to the pool, preventing a leaked/hung connection from
   * exhausting the pool. Idempotent and safe to race with {@link release}.
   */
  destroy(): void
}

interface Waiter {
  resolve: (lease: Lease) => void
  reject: (err: Error) => void
}

/**
 * Connection pool mirroring Lettuce's shared-vs-dedicated model:
 *  - `default` connections are pooled, reused, and bounded by `min`/`max`.
 *  - `blocking` and `pubsub` each get a lazily-created *dedicated* connection so
 *    a `BLPOP`/subscription never head-of-line-blocks ordinary commands.
 *
 * Idle connections are health-checked with `PING` and evicted when unhealthy.
 */
export interface PoolLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export class ConnectionPool {
  private readonly factory: ConnectionFactory
  private readonly cfg: PoolConfig
  private readonly logger?: PoolLogger

  private readonly idle: RedisClient[] = []
  private readonly leased = new Set<RedisClient>()
  private readonly waiters: Waiter[] = []
  private readonly dedicated = new Map<ConnKind, RedisClient>()

  private created = 0
  private destroyed = 0
  private closed = false
  private healthTimer?: NodeJS.Timeout

  constructor(factory: ConnectionFactory, cfg: PoolConfig, logger?: PoolLogger) {
    this.factory = factory
    this.cfg = cfg
    this.logger = logger
  }

  /** Warm up the minimum number of connections and start health checks. */
  async start(): Promise<void> {
    this.logger?.info('connecting to Redis...')
    const connectPromises: Promise<void>[] = []
    for (let i = 0; i < this.cfg.min; i++) {
      const client = this.newClient()
      this.idle.push(client)
      connectPromises.push(
        client.ping().then(
          () => {
            this.logger?.info('connection %d/%d established', i + 1, this.cfg.min)
          },
          (err: Error) => {
            this.logger?.error('connection %d/%d failed: %s', i + 1, this.cfg.min, err.message)
          },
        ),
      )
    }
    await Promise.allSettled(connectPromises)
    const alive = this.idle.filter((c) => c.status === 'ready').length
    this.logger?.info('pool warmed up: %d/%d connections ready', alive, this.cfg.min)

    if (this.cfg.healthCheckMs > 0) {
      this.healthTimer = setInterval(() => void this.healthCheck(), this.cfg.healthCheckMs)
      if (typeof this.healthTimer.unref === 'function') this.healthTimer.unref()
    }
  }

  async acquire(kind: ConnKind = 'default'): Promise<Lease> {
    if (this.closed) throw new RedisPluginError('ConnectionPool is closed')

    if (kind !== 'default') {
      const client = this.dedicatedFor(kind)
      return {
        client,
        kind,
        release: () => void 0,
        destroy: () => {
          // The dedicated connection was interrupted mid-command; drop it so a
          // fresh one is built on the next acquire of this kind.
          if (this.dedicated.get(kind) === client) this.dedicated.delete(kind)
          this.forceDestroy(client)
        },
      }
    }

    const idleClient = this.idle.pop()
    if (idleClient) return this.makeLease(idleClient, kind)

    if (this.total() < this.cfg.max) return this.makeLease(this.newClient(), kind)

    return new Promise<Lease>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  private makeLease(client: RedisClient, kind: ConnKind): Lease {
    this.leased.add(client)
    let settled = false
    // Claim the connection exactly once, whether it is released or destroyed.
    const claim = (): boolean => {
      if (settled) return false
      settled = true
      this.leased.delete(client)
      return true
    }
    return {
      client,
      kind,
      release: () => {
        if (!claim()) return
        if (this.closed) {
          void this.destroy(client)
          return
        }
        const waiter = this.waiters.shift()
        if (waiter) {
          // Hand the same connection straight to the next waiter.
          waiter.resolve(this.makeLease(client, 'default'))
          return
        }
        this.idle.push(client)
      },
      destroy: () => {
        if (!claim()) return
        this.forceDestroy(client)
      },
    }
  }

  private dedicatedFor(kind: ConnKind): RedisClient {
    let client = this.dedicated.get(kind)
    if (!client) {
      client = this.newClient()
      this.dedicated.set(kind, client)
    }
    return client
  }

  private newClient(): RedisClient {
    this.created++
    return this.factory.create()
  }

  private async destroy(client: RedisClient): Promise<void> {
    this.destroyed++
    try {
      await client.quit()
    } catch {
      try {
        client.disconnect()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Synchronously drop a connection whose command was aborted/timed out.
   * `disconnect()` (unlike `quit()`) does not wait for the in-flight command,
   * so it immediately tears the socket down and rejects pending replies.
   */
  private forceDestroy(client: RedisClient): void {
    this.destroyed++
    try {
      client.disconnect()
    } catch {
      /* ignore */
    }
  }

  private total(): number {
    return this.idle.length + this.leased.size
  }

  private async healthCheck(): Promise<void> {
    const snapshot = this.idle.splice(0, this.idle.length)
    for (const client of snapshot) {
      try {
        await client.ping()
        if (!this.closed) this.idle.push(client)
        else await this.destroy(client)
      } catch {
        await this.destroy(client)
      }
    }
  }

  stats(): PoolStats {
    return {
      active: this.leased.size,
      idle: this.idle.length,
      waiting: this.waiters.length,
      created: this.created,
      destroyed: this.destroyed,
    }
  }

  async dispose(): Promise<void> {
    this.closed = true
    if (this.healthTimer) clearInterval(this.healthTimer)

    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(new RedisPluginError('ConnectionPool disposed while waiting'))
    }
    const all: RedisClient[] = [...this.idle.splice(0), ...this.leased, ...this.dedicated.values()]
    this.idle.length = 0
    this.leased.clear()
    this.dedicated.clear()
    await Promise.all(all.map((c) => this.destroy(c)))
  }
}
