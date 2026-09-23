/**
 * Optional serialization off-load strategy.
 *
 * Large payloads (> `codec.offloadThresholdBytes`) can block the event loop
 * during JSON (de)serialization. This seam allows a `worker_threads` backend to
 * be plugged in later without touching the codec or operations. The default
 * strategy runs inline, which is correct for the common case and keeps the
 * plugin dependency-free; a real worker pool can be substituted by providing a
 * different `OffloadStrategy` implementation.
 */
export interface OffloadStrategy {
  readonly name: string
  /** Bytes above which work is considered off-loadable. */
  readonly thresholdBytes: number
  shouldOffload(byteLength: number): boolean
  run<T>(fn: () => T): Promise<T>
  dispose(): Promise<void>
}

/** Runs everything on the main thread; threshold is respected but never off-loads. */
export class InlineOffloadStrategy implements OffloadStrategy {
  readonly name = 'inline'
  readonly thresholdBytes: number

  constructor(thresholdBytes = 1_048_576) {
    this.thresholdBytes = thresholdBytes
  }

  shouldOffload(byteLength: number): boolean {
    return byteLength > this.thresholdBytes
  }

  async run<T>(fn: () => T): Promise<T> {
    return fn()
  }

  async dispose(): Promise<void> {
    /* no-op */
  }
}

export function createOffloadStrategy(thresholdBytes: number): OffloadStrategy {
  return new InlineOffloadStrategy(thresholdBytes)
}
