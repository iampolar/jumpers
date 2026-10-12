import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  splitting: false,
  // workspace packages ship TypeScript source, so they are bundled in.
  noExternal: [/^@castwave\//],
  loader: { '.sql': 'text' },
});
