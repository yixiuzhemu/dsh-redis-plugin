import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { DESTRUCTIVE_TOOLS } from './defs.js'

/**
 * Install a `tools/pre-execute` waterfall guard that blocks destructive Redis
 * tools unless `allowDestructive` is enabled. Remember to call `next()` to let
 * the chain continue (a waterfall listener that returns without calling next()
 * short-circuits the whole chain).
 */
export function installGuard(ctx: Context, allowDestructive: boolean): void {
  ctx.on(
    'tools/pre-execute',
    async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
      if (!allowDestructive && DESTRUCTIVE_TOOLS.has(exec.name)) {
        return {
          kind: 'deny',
          reason: `Tool "${exec.name}" is destructive and disabled by config (tools.allowDestructive=false).`,
        }
      }
      return next()
    },
  )
}
