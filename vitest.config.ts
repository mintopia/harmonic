import { readFileSync } from 'node:fs';
import { defineConfig, configDefaults, coverageConfigDefaults } from 'vitest/config';

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

// v8 only attributes execution counts to files in a worker that isolates per
// file; the shared-worker "fast" project (isolate:false) reports zero, which
// would deflate the whole measurement. The coverage script sets COVERAGE=1 so
// the fast project isolates too — slower, but only for the coverage run.
const measuringCoverage = process.env.COVERAGE === '1';

export default defineConfig({
  test: {
    ...shared,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html'],
      include: ['src/**/*.ts', 'web/src/**/*.{ts,tsx}'],
      exclude: [
        ...coverageConfigDefaults.exclude,
        // Runs in a worker_threads worker, so main-process v8 coverage never
        // sees it; its query logic is exercised via the stats integration tests.
        'src/db/stats-worker.ts',
        'web/src/story/**',
        '**/*.d.ts',
      ],
      thresholds: {
        lines: 75,
      },
    },
    projects: [
      {
        test: {
          ...shared,
          name: 'fast',
          include: fastFiles,
          // Reuse forked workers across files: the TS import graph (~2-3s per
          // cold file on this suite) is paid once per worker, not per file.
          isolate: measuringCoverage,
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
