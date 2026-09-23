import { describe, expect, it } from 'vitest'
import { TaskExecutor } from '../src/executor/task-executor.js'
import type { ExecutorConfig } from '../src/config.js'

function cfg(over: Partial<ExecutorConfig> = {}): ExecutorConfig {
  return {
    coreSize: 2,
    maxSize: 2,
    queueCapacity: 10,
    keepAliveMs: 1000,
    timeoutMs: 1000,
    rejectPolicy: 'abort',
    retry: { maxAttempts: 1, backoffMs: 1 },
    ...over,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('TaskExecutor', () => {
  it('bounds concurrency to the configured pool size', async () => {
    const ex = new TaskExecutor(cfg({ coreSize: 2, maxSize: 2, queueCapacity: 50 }))
    let active = 0
    let peak = 0
    const task = () =>
      ex.submit(async () => {
        active++
        peak = Math.max(peak, active)
        await sleep(10)
        active--
        return true
      })
    await Promise.all(Array.from({ length: 8 }, task))
    expect(peak).toBeLessThanOrEqual(2)
    await ex.dispose()
  })

  it('times out a stalled task and records the metric', async () => {
    const ex = new TaskExecutor(cfg({ timeoutMs: 30 }))
    await expect(ex.submit(() => new Promise<string>(() => {}))).rejects.toThrow(/timed out/)
    expect(ex.metrics().timedOut).toBe(1)
    await ex.dispose(50)
  })

  it('applies the abort reject policy when saturated', async () => {
    const ex = new TaskExecutor(cfg({ coreSize: 1, maxSize: 1, queueCapacity: 1, rejectPolicy: 'abort' }))
    let release!: () => void
    const blocker = ex.submit(() => new Promise<void>((r) => (release = r)))
    const queued = ex.submit(async () => 'queued')
    await sleep(5)
    await expect(ex.submit(async () => 'overflow')).rejects.toThrow(/saturated/)
    expect(ex.metrics().rejected).toBe(1)
    release()
    await blocker
    await expect(queued).resolves.toBe('queued')
    await ex.dispose()
  })

  it('retries idempotent tasks with exponential backoff', async () => {
    const ex = new TaskExecutor(cfg({ retry: { maxAttempts: 3, backoffMs: 1 } }))
    let calls = 0
    const result = await ex.submit(
      async () => {
        calls++
        if (calls < 3) throw new Error('Connection is closed')
        return 'ok'
      },
      { retryable: true },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
    expect(ex.metrics().retried).toBeGreaterThanOrEqual(2)
    await ex.dispose()
  })

  it('does not retry non-idempotent tasks', async () => {
    const ex = new TaskExecutor(cfg({ retry: { maxAttempts: 3, backoffMs: 1 } }))
    let calls = 0
    await expect(
      ex.submit(async () => {
        calls++
        throw new Error('Connection is closed')
      }),
    ).rejects.toThrow()
    expect(calls).toBe(1)
    await ex.dispose()
  })

  it('preserves order in submitBatch', async () => {
    const ex = new TaskExecutor(cfg({ coreSize: 4, maxSize: 4 }))
    const out = await ex.submitBatch([10, 1, 5, 3].map((d) => async () => d))
    expect(out).toEqual([10, 1, 5, 3])
    await ex.dispose()
  })

  it('rejects new work after dispose', async () => {
    const ex = new TaskExecutor(cfg())
    await ex.dispose()
    await expect(ex.submit(async () => 1)).rejects.toThrow(/disposed/)
  })
})
