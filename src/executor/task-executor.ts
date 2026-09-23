import type { ExecutorConfig } from '../config.js'
import type { ExecutorMetrics } from '../types.js'
import { RedisPluginError } from '../types.js'

export interface SubmitOptions {
  /** Override the executor-level timeout for this task. */
  timeoutMs?: number
  /**
   * Whether the task is safe to retry on transient errors. Only idempotent
   * commands (GET/SET/HGET/EXISTS...) should opt in; INCR/LPUSH must not.
   */
  retryable?: boolean
  /** Override retry attempts for this task. */
  maxAttempts?: number
}

interface QueueItem {
  run: () => void
  reject: (err: Error) => void
}

/**
 * A bounded, promise-based task executor — the Node analogue of Spring's
 * `ThreadPoolTaskExecutor`. Since JS runs on a single thread, "pooling" here
 * means bounding the number of in-flight async operations to protect the Redis
 * connection pool and provide back-pressure.
 *
 * Scheduling mirrors `java.util.concurrent.ThreadPoolExecutor`:
 *   1. active < coreSize            -> run immediately
 *   2. queue not full               -> enqueue
 *   3. active < maxSize             -> run immediately (grow past core)
 *   4. otherwise                    -> apply reject policy
 */
export class TaskExecutor {
  private readonly cfg: ExecutorConfig
  private active = 0
  private readonly queue: QueueItem[] = []
  private disposed = false
  private readonly counters: ExecutorMetrics = {
    active: 0,
    queued: 0,
    completed: 0,
    rejected: 0,
    timedOut: 0,
    retried: 0,
  }

  constructor(cfg: ExecutorConfig) {
    this.cfg = cfg
  }

  submit<T>(task: (signal: AbortSignal) => Promise<T>, opts: SubmitOptions = {}): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new RedisPluginError('TaskExecutor already disposed'))
    }
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.active++
        this.counters.active = this.active
        this.execute(task, opts)
          .then(resolve, reject)
          .finally(() => {
            this.active--
            this.counters.active = this.active
            this.counters.completed++
            this.pump()
          })
      }
      this.schedule({ run, reject })
    })
  }

  /** Run many tasks through the same admission control; preserves order. */
  async submitBatch<T>(
    tasks: Array<(signal: AbortSignal) => Promise<T>>,
    opts: SubmitOptions = {},
  ): Promise<T[]> {
    return Promise.all(tasks.map((t) => this.submit(t, opts)))
  }

  metrics(): ExecutorMetrics {
    return { ...this.counters, queued: this.queue.length }
  }

  /** Stop admitting work, reject queued tasks, and wait for in-flight to drain. */
  async dispose(graceMs = 5_000): Promise<void> {
    this.disposed = true
    while (this.queue.length > 0) {
      const item = this.queue.shift()
      item?.reject(new RedisPluginError('TaskExecutor disposed before task ran'))
    }
    const deadline = Date.now() + graceMs
    while (this.active > 0 && Date.now() < deadline) {
      await sleep(20)
    }
  }

  private schedule(item: QueueItem): void {
    if (this.active < this.cfg.coreSize) {
      item.run()
      return
    }
    if (this.queue.length < this.cfg.queueCapacity) {
      this.queue.push(item)
      this.counters.queued = this.queue.length
      return
    }
    if (this.active < this.cfg.maxSize) {
      item.run()
      return
    }
    this.applyRejectPolicy(item)
  }

  private applyRejectPolicy(item: QueueItem): void {
    this.counters.rejected++
    switch (this.cfg.rejectPolicy) {
      case 'discardOldest': {
        const oldest = this.queue.shift()
        oldest?.reject(new RedisPluginError('Task rejected: queue saturated (discardOldest)'))
        this.queue.push(item)
        this.counters.queued = this.queue.length
        return
      }
      case 'callerRuns':
        // Back-pressure: run in the caller's context, bypassing the cap.
        item.run()
        return
      case 'abort':
      default:
        item.reject(new RedisPluginError('Task rejected: executor queue saturated'))
        return
    }
  }

  private pump(): void {
    this.counters.queued = this.queue.length
    while (this.queue.length > 0 && this.active < Math.max(this.cfg.coreSize, this.cfg.maxSize)) {
      if (this.active >= this.cfg.maxSize) break
      const next = this.queue.shift()
      if (!next) break
      this.counters.queued = this.queue.length
      next.run()
    }
  }

  private async execute<T>(task: (signal: AbortSignal) => Promise<T>, opts: SubmitOptions): Promise<T> {
    const maxAttempts = opts.retryable ? (opts.maxAttempts ?? this.cfg.retry.maxAttempts) : 1
    const timeoutMs = opts.timeoutMs ?? this.cfg.timeoutMs
    let lastErr: unknown

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController()
      let timer: NodeJS.Timeout | undefined
      try {
        const result = await new Promise<T>((resolve, reject) => {
          if (timeoutMs > 0) {
            timer = setTimeout(() => {
              controller.abort()
              reject(new RedisPluginError(`Redis operation timed out after ${timeoutMs}ms`))
            }, timeoutMs)
            if (typeof timer.unref === 'function') timer.unref()
          }
          task(controller.signal).then(resolve, reject)
        })
        return result
      } catch (err) {
        lastErr = err
        if (isTimeout(err)) this.counters.timedOut++
        const canRetry = attempt < maxAttempts && isRetryable(err)
        if (!canRetry) break
        this.counters.retried++
        await sleep(this.cfg.retry.backoffMs * Math.pow(2, attempt - 1))
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    throw lastErr instanceof Error ? lastErr : new RedisPluginError('Redis operation failed')
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof RedisPluginError && err.message.includes('timed out')
}

/**
 * Transient, retryable conditions: our own timeouts, connection resets, and
 * ioredis "Connection is closed" style errors.
 */
export function isRetryable(err: unknown): boolean {
  if (isTimeout(err)) return true
  const msg = err instanceof Error ? err.message : String(err)
  return (
    /connection is closed|connect econnrefused|econnreset|etimedout|connection is ending|reconnect/i.test(msg)
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms)
    if (typeof t.unref === 'function') t.unref()
  })
}
