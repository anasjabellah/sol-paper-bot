import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/backtest/cli.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  splitting: false,
  // Bundle the TypeScript-source workspace package; keep real npm deps external.
  noExternal: ['@spb/shared'],
});
