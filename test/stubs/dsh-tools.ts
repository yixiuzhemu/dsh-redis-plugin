/**
 * Runtime stub for `@deepseek-ai/dsh-tools`, aliased in vitest.config.ts.
 *
 * The real package is an *optional* peer dependency supplied by the dsh host at
 * deploy time and is not installed here. `src/tools/defs.ts` imports `defineTool`
 * as a value, so offline unit tests need a runtime implementation. The genuine
 * `defineTool` is an identity-ish helper that returns the (validated) tool
 * definition; an identity function is enough to exercise `buildToolDefs`.
 *
 * Types still come from `src/host/dsh-sdk.d.ts` (see tsconfig.json); this file is
 * resolved only by Vitest at runtime, never by `tsc`.
 */
export function defineTool<T>(def: T): T {
  return def
}
