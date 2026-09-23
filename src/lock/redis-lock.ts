import { randomUUID } from 'node:crypto'
import type { LockConfig } from '../config.js'
import { ek, run } from '../operations/context.js'
import { evalScript } from '../operations/pipeline.js'
import type { OpsContext } from '../operations/context.js'
import { RedisPluginError, toMillis, type LockToken, type TimeUnit, type WithLockOptions } from '../types.js'
import { LockRegistry, type LockEntry } from './registry.js'
import { RENEW_SCRIPT, UNLOCK_SCRIPT } from './scripts.js'
import { WatchdogScheduler, type WatchdogLogger } from './watchdog.js'

type AnyCall = (...args: unknown[]) => Promise<unknown>

/**
 * Distributed lock with automatic watchdog renewal.
 *
 * Ports `RedisLockUtils` + `RedisLockScheduled` to Node:
 *  - acquire with atomic `SET key token NX PX ttl`
 *  - release/renew with token-guarded Lua scripts (never touch another owner's lock)
 *  - a periodic watchdog extends locks held by *this* process so long critical
 *    sections never lose the lock to TTL expiry.
 */
export class RedisLock {
  readonly registry = new LockRegistry()
  private readonly watchdog: WatchdogScheduler
  private readonly cfg: LockConfig
  private readonly log?: WatchdogLogger

  constructor(ctx: OpsContext, cfg: LockConfig, logger?: WatchdogLogger) {
    this.ctx = ctx
    this.cfg = cfg
    this.log = logger
    this.watchdog = new WatchdogScheduler({
      registry: this.registry,
      intervalMs: cfg.watchdogIntervalMs,
      renewAheadMs: cfg.renewAheadMs,
      renew: (entry) => this.renewRaw(entry),
      logger,
    })
  }

  private readonly ctx: OpsContext

  /** Try to acquire once. Returns a token (watchdog-tracked) or null. */
  async tryLock(key: string, ttl?: number, unit: TimeUnit = 'ms'): Promise<LockToken | null> {
    const ttlMs = ttl === undefined ? this.cfg.defaultTtlMs : toMillis(ttl, unit)
    const token = randomUUID()
    const encodedKey = ek(this.ctx, key)
    const res = await run(
      this.ctx,
      (c) => (c.set as AnyCall)(encodedKey, token, 'PX', ttlMs, 'NX') as Promise<'OK' | null>,
    )
    if (res !== 'OK') return null

    const now = Date.now()
    const lockToken: LockToken = { key, value: token, ttlMs, acquiredAt: now }
    this.registry.add({
      key,
      encodedKey,
      token: lockToken,
      ttlMs,
      nextRenewAt: now + Math.max(0, ttlMs - this.cfg.renewAheadMs),
    })
    return lockToken
  }

  /** Acquire with retry (mirrors `RedisLockUtils.tryLockWithRetry`). */
  async tryLockWithRetry(
    key: string,
    ttl: number,
    retryInterval: number,
    retryCount: number,
    unit: TimeUnit = 'ms',
  ): Promise<LockToken | null> {
    let attempt = 0
    for (;;) {
      const token = await this.tryLock(key, ttl, unit)
      if (token) return token
      if (attempt >= retryCount) return null
      attempt++
      await sleep(retryInterval)
    }
  }

  /**
   * Run `fn` while holding the lock; always releases in `finally`.
   * The watchdog keeps the lock alive for the duration of `fn`.
   */
  async withLock<T>(key: string, fn: () => Promise<T>, opts: WithLockOptions = {}): Promise<T> {
    const unit = opts.unit ?? 'ms'
    const token =
      opts.retryCount && opts.retryCount > 0
        ? await this.tryLockWithRetry(
            key,
            opts.ttl ?? this.cfg.defaultTtlMs,
            opts.retryInterval ?? 100,
            opts.retryCount,
            unit,
          )
        : await this.tryLock(key, opts.ttl, unit)

    if (!token) throw new RedisPluginError(`Failed to acquire lock: ${key}`)

    // Attach the onLost callback to the tracked entry.
    if (opts.onLost) {
      const entry = this.registry.get(token.value)
      if (entry) entry.onLost = opts.onLost
    }

    try {
      return await fn()
    } finally {
      await this.unlock(key, token)
    }
  }

  /** Token-guarded atomic unlock. */
  async unlock(key: string, token: LockToken): Promise<boolean> {
    const encodedKey = ek(this.ctx, key)
    const res = await evalScript<number>(this.ctx, UNLOCK_SCRIPT, [encodedKey], [token.value])
    this.registry.remove(token.value)
    return Number(res) > 0
  }

  /** Token-guarded atomic renewal. */
  async renew(key: string, token: LockToken, ttl?: number, unit: TimeUnit = 'ms'): Promise<boolean> {
    const ttlMs = ttl === undefined ? token.ttlMs : toMillis(ttl, unit)
    const encodedKey = ek(this.ctx, key)
    const res = await evalScript<number>(this.ctx, RENEW_SCRIPT, [encodedKey], [token.value, ttlMs])
    return Number(res) > 0
  }

  /** Whether the lock is still held by this token. */
  async isHeldByMe(key: string, token: LockToken): Promise<boolean> {
    const encodedKey = ek(this.ctx, key)
    const raw = await run(this.ctx, (c) => c.get(encodedKey) as Promise<string | null>, {
      retryable: true,
    })
    return raw === token.value
  }

  /** Number of locks held by this process. */
  get heldCount(): number {
    return this.registry.size
  }

  /** Start the watchdog; returns a reversible disposer (register via ctx.effect). */
  startWatchdog(): () => void {
    return this.watchdog.start()
  }

  stopWatchdog(): void {
    this.watchdog.stop()
  }

  /**
   * Shutdown. By default relies on TTL (stops renewing, keeps locks until they
   * expire) to avoid deleting locks whose critical section may still be running.
   * When `releaseOnDispose` is set, actively releases all locally-held locks.
   */
  async dispose(): Promise<void> {
    this.watchdog.stop()
    if (!this.cfg.releaseOnDispose) {
      this.registry.clear()
      return
    }
    const held = this.registry.clear()
    await Promise.all(held.map((e) => this.unlock(e.key, e.token).catch(() => false)))
  }

  private async renewRaw(entry: LockEntry): Promise<boolean> {
    const res = await evalScript<number>(
      this.ctx,
      RENEW_SCRIPT,
      [entry.encodedKey],
      [entry.token.value, entry.ttlMs],
    )
    return Number(res) > 0
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms)
    if (typeof t.unref === 'function') t.unref()
  })
}
