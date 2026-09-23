/**
 * Key serializer — mirrors Spring `StringRedisSerializer` plus an optional
 * namespace prefix (e.g. `dsh:{plugin}:`) for multi-tenant isolation.
 */
export interface KeySerializer {
  /** Apply prefix; used on every outbound key. */
  serialize(key: string): string
  /** Strip prefix; used on keys returned by SCAN / KEYS. */
  deserialize(raw: string): string
  /** Serialize a SCAN match pattern (prefix inserted before the glob). */
  serializePattern(pattern: string): string
  readonly prefix: string
}

export class PrefixedKeySerializer implements KeySerializer {
  readonly prefix: string

  constructor(prefix = '') {
    this.prefix = prefix
  }

  serialize(key: string): string {
    return this.prefix ? `${this.prefix}${key}` : key
  }

  deserialize(raw: string): string {
    return this.prefix && raw.startsWith(this.prefix) ? raw.slice(this.prefix.length) : raw
  }

  serializePattern(pattern: string): string {
    return this.prefix ? `${this.prefix}${pattern}` : pattern
  }
}
