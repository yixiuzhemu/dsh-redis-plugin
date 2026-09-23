import type { CodecConfig } from '../config.js'
import { PrefixedKeySerializer, type KeySerializer } from './key.js'
import { createValueSerializer, type ValueSerializer } from './value.js'

/**
 * Codec bundles the key and value serializers, mirroring how `RedisTemplate`
 * holds `keySerializer` / `valueSerializer` / `hashKeySerializer`.
 */
export interface Codec {
  readonly keys: KeySerializer
  readonly values: ValueSerializer
  /** Bytes threshold above which (de)serialization may be offloaded. */
  readonly offloadThresholdBytes: number
}

export function createCodec(config: CodecConfig): Codec {
  return {
    keys: new PrefixedKeySerializer(config.keyPrefix ?? ''),
    values: createValueSerializer(config.value, config.typeHint ?? false),
    offloadThresholdBytes: config.offloadThresholdBytes ?? 1_048_576,
  }
}

export * from './key.js'
export * from './value.js'
