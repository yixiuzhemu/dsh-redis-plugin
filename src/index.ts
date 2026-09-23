import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, type Config as RedisConfig } from './config.js'
import { createRedis } from './service.js'
import type { RedisService } from './service.js'
import { registerRedisTools } from './tools/index.js'

/**
 * Type augmentation so consumer plugins get a typed `ctx.redis` after adding
 * `export const inject = ['redis']`. This merges with the genuine Cordis
 * `Context` when the plugin runs inside a real dsh host.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    redis: RedisService
  }
}

/** Plugin display name (diagnostics only). */
export const name = 'dsh-redis-plugin'

/** Environments recognized by the `REDIS_ENV` selector (diagnostics only). */
const KNOWN_ENVS = ['dev', 'test', 'uat', 'prod'] as const

/**
 * No hard service dependencies: this is a foundational capability. Consumers
 * depend on *us* via `inject: ['redis']`, not the other way around.
 */
export const inject: string[] = []

/** Deployment-time config schema (schemastery) + `Config` type, re-exported. */
export { Config }
export type { RedisConfig as ConfigType }

/**
 * Plugin body. Registers everything as reversible effects so HMR / unload roll
 * back cleanly (connections, timers, tools).
 */
export function apply(ctx: Context, config: RedisConfig): void {
  const resolved = resolveConfig(config ?? ({} as RedisConfig))

  const redis = createRedis(resolved, { logger: ctx.logger })

  // 1) Expose the service on a stable context key for other plugins to inject.
  ctx.provide('redis', redis)

  // 2) Warm up the connection pool (non-blocking; connects lazily/eagerly per client).
  void redis.start()

  // 3) Register model-visible tools + destructive-op guard (reversible).
  if (resolved.tools.enabled) registerRedisTools(ctx, redis, resolved.tools)

  // 4) Lock watchdog timer — reversible; auto-cleared on unload/HMR.
  ctx.effect(() => redis.lock.startWatchdog())

  // 5) Graceful shutdown — drain executor and quit connections on teardown.
  ctx.effect(() => () => redis.dispose())

  // Environment label (REDIS_ENV) is diagnostic: it names which deployment
  // profile injected the REDIS_* connection vars. Never log the raw url — it may
  // carry credentials.
  const env = process.env.REDIS_ENV || 'default'
  if (process.env.REDIS_ENV && !(KNOWN_ENVS as readonly string[]).includes(process.env.REDIS_ENV)) {
    ctx.logger.warn(
      '[dsh-redis-plugin] unknown REDIS_ENV=%s (expected one of: %s)',
      process.env.REDIS_ENV,
      KNOWN_ENVS.join(', '),
    )
  }
  const target = resolved.connection.url
    ? 'via REDIS_URL'
    : `${resolved.connection.host}:${resolved.connection.port}/${resolved.connection.db ?? 0}`

  ctx.logger.info(
    '[dsh-redis-plugin] ready (env=%s, topology=%s, target=%s, tools=%s)',
    env,
    resolved.connection.topology,
    target,
    resolved.tools.enabled ? 'on' : 'off',
  )
}
