import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Vitest config.
 *
 * The `@deepseek-ai/*` SDK packages are optional peer dependencies provided by
 * the dsh host at deploy time and are not installable in this standalone repo.
 * `config.ts` imports `@deepseek-ai/schemastery` at module load, and
 * `tools/defs.ts` imports `defineTool` from `@deepseek-ai/dsh-tools`, so we alias
 * both to chainable/identity no-op stubs for offline unit tests. Types still come
 * from `src/host/dsh-sdk.d.ts` (see tsconfig.json).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/schemastery': fileURLToPath(new URL('./test/stubs/schemastery.ts', import.meta.url)),
      '@deepseek-ai/dsh-tools': fileURLToPath(new URL('./test/stubs/dsh-tools.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
