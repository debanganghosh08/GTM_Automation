import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Suites share one embedded Postgres handle per process, so they must not run
    // concurrently within a file's process. Vitest 5 forks by default; `fileParallelism`
    // off keeps separate files from racing each other over the same temp databases.
    fileParallelism: false,
  },
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
});
