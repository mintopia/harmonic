import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const port = 47421;
const dataDir = process.env.HARMONIC_E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'harmonic-e2e-'));
process.env.HARMONIC_E2E_DATA_DIR = dataDir;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: 'chrome',
    colorScheme: 'light',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: `node dist/cli.js serve --data-dir ${dataDir} --port ${port} --password verify-pass`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
