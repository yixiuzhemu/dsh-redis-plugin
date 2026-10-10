import type { Context } from '@deepseek-ai/cordis'
import type { ToolsConfig } from '../config.js'
import type { RedisService } from '../service.js'
import { buildToolDefs } from './defs.js'
import { installGuard } from './guard.js'

/**
 * Register the model-visible Redis tools onto `ctx.tools` and install the
 * destructive-operation guard. All registrations are reversible (they use the
 * context's effect/on machinery) so unload & HMR roll them back automatically.
 */
export function registerRedisTools(ctx: Context, redis: RedisService, config: ToolsConfig): void {
  if (!ctx.tools) {
    console.log('[dsh-redis-plugin] WARN: ctx.tools unavailable; skipping tool registration')
    return
  }
  const defs = buildToolDefs(redis, config)
  for (const def of defs) {
    ctx.tools.register(def)
  }
  installGuard(ctx, config.allowDestructive)
  console.log(`[dsh-redis-plugin] registered ${defs.length} redis tools`)
}

export { DESTRUCTIVE_TOOLS } from './defs.js'
