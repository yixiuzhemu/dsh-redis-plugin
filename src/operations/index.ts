import { hashOps } from './hash.js'
import { keyOps } from './key.js'
import { listOps } from './list.js'
import { createPipeline, createTransaction } from './pipeline.js'
import { setOps } from './set.js'
import { stringOps } from './string.js'
import { zsetOps } from './zset.js'
import type { OpsContext } from './context.js'

/** All data-type operations merged into a single flat surface. */
export function createOperations(ctx: OpsContext) {
  return {
    ...keyOps(ctx),
    ...stringOps(ctx),
    ...hashOps(ctx),
    ...listOps(ctx),
    ...setOps(ctx),
    ...zsetOps(ctx),
    pipeline: () => createPipeline(ctx),
    multi: () => createTransaction(ctx),
  }
}

export type Operations = ReturnType<typeof createOperations>

export * from './context.js'
export * from './key.js'
export * from './string.js'
export * from './hash.js'
export * from './list.js'
export * from './set.js'
export * from './zset.js'
export * from './pipeline.js'
