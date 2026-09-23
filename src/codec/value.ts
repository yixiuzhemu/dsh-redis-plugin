import { RedisPluginError, type ValueEncoding } from '../types.js'

/**
 * Value serializer — mirrors Spring `GenericJackson2JsonRedisSerializer`
 * (JSON with optional type hints), plus `string` and `raw` strategies.
 */
export interface ValueSerializer {
  readonly encoding: ValueEncoding
  serialize(value: unknown): string | Buffer
  deserialize<T = unknown>(raw: string | Buffer | null): T | null
}

const TYPE_TAG = '@type'

/**
 * Replacer that tags special types. Uses the holder (`this[key]`) to read the
 * *raw* value, because `JSON.stringify` invokes `Date.toJSON()` before calling
 * the replacer — so the `val` argument would already be a plain string.
 */
function hintReplacer(this: unknown, key: string, val: unknown): unknown {
  const raw = (this as Record<string, unknown>)[key]
  if (raw instanceof Date) return { [TYPE_TAG]: 'Date', value: raw.toISOString() }
  if (raw instanceof Map) return { [TYPE_TAG]: 'Map', value: [...raw.entries()] }
  if (raw instanceof Set) return { [TYPE_TAG]: 'Set', value: [...raw.values()] }
  if (Buffer.isBuffer(raw)) return { [TYPE_TAG]: 'Buffer', value: raw.toString('base64') }
  if (raw instanceof Uint8Array) {
    return { [TYPE_TAG]: 'Buffer', value: Buffer.from(raw).toString('base64') }
  }
  return val
}

/** Reversible JSON with optional `@type` hints for Date / Map / Set / Buffer. */
export class JsonValueSerializer implements ValueSerializer {
  readonly encoding = 'json' as const
  private readonly typeHint: boolean

  constructor(typeHint = false) {
    this.typeHint = typeHint
  }

  serialize(value: unknown): string {
    if (value === undefined) {
      throw new RedisPluginError('Cannot serialize `undefined`; use null to represent absence')
    }
    return JSON.stringify(value, this.typeHint ? hintReplacer : undefined)
  }

  deserialize<T>(raw: string | Buffer | null): T | null {
    if (raw === null) return null
    const text = typeof raw === 'string' ? raw : raw.toString('utf8')
    if (text === '') return null
    try {
      return JSON.parse(text, this.typeHint ? this.reviver : undefined) as T
    } catch (err) {
      // Fall back to returning the raw text when the payload is not valid JSON.
      return text as unknown as T
    }
  }

  private reviver = (_key: string, val: unknown): unknown => {
    if (val && typeof val === 'object' && TYPE_TAG in (val as Record<string, unknown>)) {
      const tagged = val as Record<string, unknown>
      const inner = tagged.value
      switch (tagged[TYPE_TAG]) {
        case 'Date':
          return new Date(inner as string)
        case 'Map':
          return new Map(inner as [unknown, unknown][])
        case 'Set':
          return new Set(inner as unknown[])
        case 'Buffer':
          return Buffer.from(inner as string, 'base64')
        default:
          return val
      }
    }
    return val
  }
}

/** Plain UTF-8 text; no JSON parsing on read. */
export class StringValueSerializer implements ValueSerializer {
  readonly encoding = 'string' as const

  serialize(value: unknown): string {
    if (value === null || value === undefined) {
      throw new RedisPluginError('Cannot serialize null/undefined with the string serializer')
    }
    return typeof value === 'string' ? value : String(value)
  }

  deserialize<T>(raw: string | Buffer | null): T | null {
    if (raw === null) return null
    return (typeof raw === 'string' ? raw : raw.toString('utf8')) as unknown as T
  }
}

/** Binary pass-through; values must be Buffer / Uint8Array / string. */
export class RawValueSerializer implements ValueSerializer {
  readonly encoding = 'raw' as const

  serialize(value: unknown): Buffer {
    if (Buffer.isBuffer(value)) return value
    if (value instanceof Uint8Array) return Buffer.from(value)
    if (typeof value === 'string') return Buffer.from(value, 'utf8')
    throw new RedisPluginError('Raw serializer only accepts Buffer / Uint8Array / string')
  }

  deserialize<T>(raw: string | Buffer | null): T | null {
    if (raw === null) return null
    return (Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8')) as unknown as T
  }
}

export function createValueSerializer(encoding: ValueEncoding, typeHint = false): ValueSerializer {
  switch (encoding) {
    case 'json':
      return new JsonValueSerializer(typeHint)
    case 'string':
      return new StringValueSerializer()
    case 'raw':
      return new RawValueSerializer()
    default:
      throw new RedisPluginError(`Unknown value encoding: ${String(encoding)}`)
  }
}
