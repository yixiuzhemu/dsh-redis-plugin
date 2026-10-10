import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { RedisService } from '../service.js'
import type { ToolsConfig } from '../config.js'

/** Destructive tool names gated by `allowDestructive`. */
export const DESTRUCTIVE_TOOLS = new Set(['redis_del'])

const jsonOutput = {
  schema: { type: 'object' as const, additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/** Coerce a model-supplied string into structured JSON when possible. */
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * Build the model-visible Redis tools. Each `execute` returns exactly one
 * canonical JSON value (per the dsh tool contract) and honours `exec.signal`.
 */
export function buildToolDefs(redis: RedisService, _opts: ToolsConfig): ToolDefinition[] {
  return [
    defineTool({
      name: 'redis_get',
      description: 'Get the value stored at a Redis key (string/hash/list/set/zset values are JSON-decoded).',
      parameters: { key: { type: 'string', required: true, description: 'The Redis key' } },
      output: jsonOutput,
      async execute(args) {
        const value = await redis.get(String(args.key))
        return { key: String(args.key), value, exists: value !== null }
      },
    }),

    defineTool({
      name: 'redis_set',
      description: 'Set a Redis key to a value, with an optional TTL in seconds.',
      parameters: {
        key: { type: 'string', required: true, description: 'The Redis key' },
        value: { type: 'string', required: true, description: 'Value (JSON-encoded when parseable)' },
        ex: { type: 'number', description: 'Optional TTL in seconds' },
      },
      output: jsonOutput,
      async execute(args) {
        const ex = typeof args.ex === 'number' ? args.ex : undefined
        await redis.set(String(args.key), parseValue(String(args.value)), ex !== undefined ? { ex } : undefined)
        return { key: String(args.key), ok: true, ex: ex ?? null }
      },
    }),

    defineTool({
      name: 'redis_del',
      description: 'Delete one or more Redis keys. Returns the number of keys removed.',
      parameters: {
        keys: {
          type: 'array',
          required: true,
          description: 'Keys to delete',
          items: { type: 'string' },
        },
      },
      output: jsonOutput,
      async execute(args) {
        const keys = (args.keys as unknown[])?.map(String) ?? []
        const deleted = await redis.del(keys)
        return { deleted }
      },
    }),

    defineTool({
      name: 'redis_scan',
      description: 'Scan keys by glob pattern using a safe cursor (never uses KEYS). Returns up to `limit` keys.',
      parameters: {
        match: { type: 'string', description: 'Glob pattern, e.g. user:*', default: '*' },
        limit: { type: 'number', description: 'Max keys to return', default: 100 },
      },
      output: jsonOutput,
      async execute(args, exec) {
        const limit = typeof args.limit === 'number' ? args.limit : 100
        const keys: string[] = []
        for await (const k of redis.scan({ match: String(args.match ?? '*'), count: 200 })) {
          if (exec.signal.aborted) break
          keys.push(k)
          if (keys.length >= limit) break
        }
        return { keys, count: keys.length, truncated: keys.length >= limit }
      },
    }),

    defineTool({
      name: 'redis_exists',
      description: 'Check whether a Redis key exists.',
      parameters: { key: { type: 'string', required: true } },
      output: jsonOutput,
      async execute(args) {
        return { key: String(args.key), exists: await redis.exists(String(args.key)) }
      },
    }),

    defineTool({
      name: 'redis_ttl',
      description: 'Get the remaining TTL of a key in seconds (-1 = no expiry, -2 = missing).',
      parameters: { key: { type: 'string', required: true } },
      output: jsonOutput,
      async execute(args) {
        return { key: String(args.key), ttl: await redis.ttl(String(args.key), 's') }
      },
    }),

    defineTool({
      name: 'redis_type',
      description: 'Get the data type of a key (string/list/set/zset/hash/none).',
      parameters: { key: { type: 'string', required: true } },
      output: jsonOutput,
      async execute(args) {
        return { key: String(args.key), type: await redis.type(String(args.key)) }
      },
    }),

    defineTool({
      name: 'redis_hgetall',
      description: 'Get all field/value pairs of a Redis hash.',
      parameters: { key: { type: 'string', required: true } },
      output: jsonOutput,
      async execute(args) {
        return { key: String(args.key), value: await redis.hGetAll(String(args.key)) }
      },
    }),

    defineTool({
      name: 'redis_hset',
      description: 'Set a field in a Redis hash.',
      parameters: {
        key: { type: 'string', required: true },
        field: { type: 'string', required: true },
        value: { type: 'string', required: true },
      },
      output: jsonOutput,
      async execute(args) {
        const added = await redis.hSet(String(args.key), String(args.field), parseValue(String(args.value)))
        return { key: String(args.key), field: String(args.field), added }
      },
    }),

    defineTool({
      name: 'redis_incrby',
      description: 'Atomically increment an integer value by a delta (negative to decrement).',
      parameters: {
        key: { type: 'string', required: true },
        amount: { type: 'number', description: 'Increment (default 1)', default: 1 },
      },
      output: jsonOutput,
      async execute(args) {
        const amount = typeof args.amount === 'number' ? args.amount : 1
        return { key: String(args.key), value: await redis.incrBy(String(args.key), amount) }
      },
    }),

    defineTool({
      name: 'redis_lock',
      description: 'Acquire a distributed lock (auto-renewed by a watchdog). Returns a token to pass to redis_unlock.',
      parameters: {
        key: { type: 'string', required: true },
        ttlSeconds: { type: 'number', description: 'Lock TTL in seconds (default 30)', default: 30 },
      },
      output: jsonOutput,
      async execute(args) {
        const ttl = typeof args.ttlSeconds === 'number' ? args.ttlSeconds : 30
        const token = await redis.lock.tryLock(String(args.key), ttl, 's')
        return { key: String(args.key), acquired: token !== null, token: token?.value ?? null }
      },
    }),

    defineTool({
      name: 'redis_unlock',
      description: 'Release a distributed lock previously acquired via redis_lock, using its token.',
      parameters: {
        key: { type: 'string', required: true },
        token: { type: 'string', required: true },
      },
      output: jsonOutput,
      async execute(args) {
        const key = String(args.key)
        const tokenValue = String(args.token)
        const released = await redis.lock.unlock(key, {
          key,
          value: tokenValue,
          ttlMs: 0,
          acquiredAt: 0,
        })
        return { key, released }
      },
    }),
  ]
}
