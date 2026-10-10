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

/**
 * Terminal logger: writes to stdout so logs appear in both CLI and desktop host.
 * - CLI mode: stdout goes directly to the terminal.
 * - Desktop host: child.stdout is piped to the main process stdout (visible),
 *   while child.stderr is buffered silently (NOT forwarded to any terminal).
 * Therefore stdout is the only reliable channel for diagnostic output.
 */
function log(message: string): void {
  console.log(`[dsh-redis-plugin] ${message}`)
}

/** Environments recognized by the `REDIS_ENV` selector (diagnostics only). */
const KNOWN_ENVS = ['dev', 'test', 'uat', 'prod'] as const

/**
 * Service dependencies: this plugin provides `ctx.redis` as a foundational
 * capability, but optionally registers model-visible tools if `ctx.tools` is
 * available in the host environment.
 */
export const inject: string[] = ['tools']

/** Deployment-time config schema (schemastery) + `Config` type, re-exported. */
export { Config }
export type { RedisConfig as ConfigType }

/**
 * Plugin body. Registers everything as reversible effects so HMR / unload roll
 * back cleanly (connections, timers, tools).
 */
export function apply(ctx: Context, config: RedisConfig): void {
  const resolved = resolveConfig(config ?? ({} as RedisConfig))

  // Use a stdout-based logger for the pool/watchdog so output is visible in
  // both CLI and desktop host (desktop only forwards child stdout, not stderr).
  const terminalLogger = {
    info: (...args: unknown[]) => console.log('[dsh-redis-plugin]', ...args),
    warn: (...args: unknown[]) => console.log('[dsh-redis-plugin] WARN:', ...args),
    error: (...args: unknown[]) => console.log('[dsh-redis-plugin] ERROR:', ...args),
  }

  const redis = createRedis(resolved, { logger: terminalLogger })

  // 1) Expose the service on a stable context key for other plugins to inject.
  ctx.provide('redis', redis)

  // 2) Warm up the connection pool and log the result.
  void redis.start().then(
    () => log('all pool connections are ready'),
    (err) => log(`pool startup failed: ${String(err)}`),
  )

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
    log(`unknown REDIS_ENV=${process.env.REDIS_ENV} (expected one of: ${KNOWN_ENVS.join(', ')})`)
  }
  const target = resolved.connection.url
    ? 'via REDIS_URL'
    : `${resolved.connection.host}:${resolved.connection.port}/${resolved.connection.db ?? 0}`

  log(`ready (env=${env}, topology=${resolved.connection.topology}, target=${target}, tools=${resolved.tools.enabled ? 'on' : 'off'})`)
}
