import { describe, expect, it } from 'vitest'
import {
  JsonValueSerializer,
  RawValueSerializer,
  StringValueSerializer,
} from '../src/codec/value.js'
import { PrefixedKeySerializer } from '../src/codec/key.js'
import { toMillis } from '../src/types.js'

describe('JsonValueSerializer', () => {
  it('round-trips plain JSON without type hints', () => {
    const s = new JsonValueSerializer(false)
    const raw = s.serialize({ a: 1, b: [1, 2, 3] })
    expect(s.deserialize(raw)).toEqual({ a: 1, b: [1, 2, 3] })
  })

  it('restores Date/Map/Set/Buffer when typeHint is on', () => {
    const s = new JsonValueSerializer(true)
    const value = {
      when: new Date('2026-09-23T00:00:00.000Z'),
      map: new Map([['k', 'v']]),
      set: new Set([1, 2]),
      buf: Buffer.from('hi'),
    }
    const restored = s.deserialize<typeof value>(s.serialize(value))!
    expect(restored.when).toBeInstanceOf(Date)
    expect(restored.when.toISOString()).toBe('2026-09-23T00:00:00.000Z')
    expect(restored.map).toBeInstanceOf(Map)
    expect(restored.map.get('k')).toBe('v')
    expect(restored.set).toBeInstanceOf(Set)
    expect([...restored.set]).toEqual([1, 2])
    expect(Buffer.isBuffer(restored.buf)).toBe(true)
    expect(restored.buf.toString()).toBe('hi')
  })

  it('returns null for null and empty payloads', () => {
    const s = new JsonValueSerializer()
    expect(s.deserialize(null)).toBeNull()
    expect(s.deserialize('')).toBeNull()
  })

  it('falls back to raw text when payload is not JSON', () => {
    const s = new JsonValueSerializer()
    expect(s.deserialize('not-json')).toBe('not-json')
  })

  it('rejects undefined', () => {
    const s = new JsonValueSerializer()
    expect(() => s.serialize(undefined)).toThrow()
  })
})

describe('StringValueSerializer / RawValueSerializer', () => {
  it('string serializer passes text through', () => {
    const s = new StringValueSerializer()
    expect(s.serialize('hello')).toBe('hello')
    expect(s.deserialize('hello')).toBe('hello')
  })

  it('raw serializer handles Buffer round-trip', () => {
    const s = new RawValueSerializer()
    const buf = s.serialize(Buffer.from([1, 2, 3]))
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(s.deserialize<Buffer>(buf as Buffer)).toEqual(Buffer.from([1, 2, 3]))
  })
})

describe('PrefixedKeySerializer', () => {
  it('applies and strips the prefix', () => {
    const k = new PrefixedKeySerializer('dsh:test:')
    expect(k.serialize('user:1')).toBe('dsh:test:user:1')
    expect(k.deserialize('dsh:test:user:1')).toBe('user:1')
    expect(k.serializePattern('user:*')).toBe('dsh:test:user:*')
  })

  it('is a no-op without a prefix', () => {
    const k = new PrefixedKeySerializer()
    expect(k.serialize('a')).toBe('a')
    expect(k.deserialize('a')).toBe('a')
  })
})

describe('toMillis', () => {
  it('converts each unit', () => {
    expect(toMillis(1, 'ms')).toBe(1)
    expect(toMillis(1, 's')).toBe(1000)
    expect(toMillis(2, 'm')).toBe(120_000)
    expect(toMillis(1, 'h')).toBe(3_600_000)
    expect(toMillis(1, 'd')).toBe(86_400_000)
  })
})
