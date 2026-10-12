import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@castwave/contracts': r('./packages/contracts/src/index.ts'),
      '@castwave/core': r('./packages/core/src/index.ts'),
      '@castwave/runtime': r('./packages/runtime/src/index.ts'),
      '@castwave/db': r('./packages/db/src/index.ts'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    /*
     * Cada arquivo de teste de integracao sobe sua propria instancia PGlite em
     * memoria. Isolar por fork evita que o WASM de um teste veja o schema do
     * outro, e mantem os testes paralelos de verdade.
     */
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: './test-results/junit.xml' },
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts', 'packages/contracts/src/**/*.ts', 'apps/api/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/cli/**'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
