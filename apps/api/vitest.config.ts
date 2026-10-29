import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Blocks every non-loopback fetch / WebSocket in tests (see the file for details).
    setupFiles: ['test/setup-network-guard.ts'],
    environment: 'node',
    testTimeout: 20_000,
    pool: 'forks',
    // Keep memory use modest on small machines.
    poolOptions: { forks: { maxForks: 2, minForks: 1 } },
  },
});
