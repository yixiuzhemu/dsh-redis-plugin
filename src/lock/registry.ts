import type { LockToken } from '../types.js'

/** A lock currently held by *this* process, tracked for watchdog renewal. */
export interface LockEntry {
  /** Logical (unprefixed) key. */
  key: string
  /** Encoded key actually stored in Redis (prefix applied). */
  encodedKey: string
  token: LockToken
  ttlMs: number
  /** Epoch ms at which the next renewal should be attempted. */
  nextRenewAt: number
  /** Invoked when renewal detects the lock has been lost / re-acquired. */
  onLost?: (key: string) => void
}

/**
 * In-process registry of held locks, keyed by token value.
 *
 * The Java reference keyed this by `Thread.currentThread().getId()`. Node has no
 * thread identity for async tasks, so we key by the unique lock token instead,
 * which is the correct ownership credential.
 */
export class LockRegistry {
  private readonly entries = new Map<string, LockEntry>()

  add(entry: LockEntry): void {
    this.entries.set(entry.token.value, entry)
  }

  get(tokenValue: string): LockEntry | undefined {
    return this.entries.get(tokenValue)
  }

  remove(tokenValue: string): boolean {
    return this.entries.delete(tokenValue)
  }

  /** Snapshot of all held locks (safe to iterate while mutating). */
  list(): LockEntry[] {
    return [...this.entries.values()]
  }

  clear(): LockEntry[] {
    const all = this.list()
    this.entries.clear()
    return all
  }

  get size(): number {
    return this.entries.size
  }
}
