import type { LockEntry, LockRegistry } from './registry.js'

export interface WatchdogLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface WatchdogOptions {
  registry: LockRegistry
  /** Scan interval in ms (mirrors `@Scheduled(fixedRate = 1000)`). */
  intervalMs: number
  /** Renew when fewer than this many ms remain before expiry. */
  renewAheadMs: number
  /** Attempt to extend one lock; resolves true when still owned. */
  renew: (entry: LockEntry) => Promise<boolean>
  logger?: WatchdogLogger
}

const noopLogger: WatchdogLogger = {
  info: () => void 0,
  warn: () => void 0,
  error: () => void 0,
}

/**
 * Periodic renewal loop — the Node analogue of `RedisLockScheduled.renewal()`.
 * Keeps held locks alive so long-running critical sections never lose the lock
 * to TTL expiry (which would allow a second owner in and cause concurrent writes).
 *
 * The timer is created via {@link start}, which returns a disposer so the plugin
 * can register it as a reversible `ctx.effect()` (auto-cleared on unload/HMR).
 */
export class WatchdogScheduler {
  private readonly opts: WatchdogOptions
  private readonly log: WatchdogLogger
  private timer?: NodeJS.Timeout
  private ticking = false

  constructor(opts: WatchdogOptions) {
    this.opts = opts
    this.log = opts.logger ?? noopLogger
  }

  /** Start the loop; returns a disposer that stops it. Idempotent. */
  start(): () => void {
    if (this.timer) return () => this.stop()
    const interval = Math.max(50, this.opts.intervalMs)
    this.timer = setInterval(() => void this.tick(), interval)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    return () => this.stop()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** One renewal pass. Exposed for deterministic unit tests. */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const entry of this.opts.registry.list()) {
        if (now < entry.nextRenewAt) continue
        let ok = false
        try {
          ok = await this.opts.renew(entry)
        } catch (err) {
          this.log.error('[dsh-redis] lock renewal error for %s: %s', entry.key, String(err))
        }
        if (ok) {
          entry.nextRenewAt = Date.now() + Math.max(0, entry.ttlMs - this.opts.renewAheadMs)
          this.log.info('[dsh-redis] lock renewed: %s', entry.key)
        } else {
          // Lost / re-acquired by another owner: stop tracking and notify.
          this.opts.registry.remove(entry.token.value)
          this.log.warn('[dsh-redis] lock lost (not renewed): %s', entry.key)
          try {
            entry.onLost?.(entry.key)
          } catch {
            /* user callback errors must not break the loop */
          }
        }
      }
    } finally {
      this.ticking = false
    }
  }
}
