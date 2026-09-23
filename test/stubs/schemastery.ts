/**
 * Runtime stub for `@deepseek-ai/schemastery`, aliased in vitest.config.ts.
 *
 * The real package is an *optional* peer dependency supplied by the dsh host at
 * deploy time (see package.json + src/host/dsh-sdk.d.ts). Offline unit tests
 * never validate a config payload — they call `resolveConfig()` with plain
 * objects — so `config.ts`'s module-level `Config = z.object({...})` only needs
 * to *evaluate* without throwing. A fully chainable no-op proxy satisfies that.
 */
function chainable(): unknown {
  const target = (() => void 0) as unknown as (...a: unknown[]) => unknown
  // Every property access and every call returns the proxy itself, so arbitrary
  // chains like `z.enum([...]).default('x')` or `z.string().optional()` resolve.
  const proxy: (...a: unknown[]) => unknown = new Proxy(target, {
    get: () => proxy,
    apply: () => proxy,
  })
  return proxy
}

const z = chainable()
export default z
