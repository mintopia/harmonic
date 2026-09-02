import { readFileSync } from 'node:fs';
import { defineConfig, configDefaults } from 'vitest/config';

const fastFiles = readFileSync(new URL('./tests/fast-pool.list', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

const shared = {
  testTimeout: 20_000,
  hookTimeout: 20_000,
  pool: 'forks',
  setupFiles: ['./tests/setup-env.ts'],
} as const;

export default defineConfig({
  test: {
    ...shared,
    projects: [
      {
        test: {
          ...shared,
          name: 'fast',
          include: fastFiles,
          // Reuse forked workers across files: the TS import graph (~2-3s per
          // cold file on this suite) is paid once per worker, not per file.
          isolate: false,
        },
      },
      {
        test: {
          ...shared,
          name: 'isolated',
          include: ['tests/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...fastFiles],
        },
      },
    ],
  },
});
