import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectDistributionMode } from '../src/distribution-mode.js';
import { buildApp } from '../src/server/app.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function appRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-distribution-mode-'));
  roots.push(root);
  return root;
}

describe('detectDistributionMode', () => {
  it('reports source when the app root contains a git marker', () => {
    const root = appRoot();
    writeFileSync(join(root, '.git'), 'gitdir: /worktrees/harmonic');

    expect(detectDistributionMode(root)).toBe('source');
  });

  it('reports packaged when the app root has no git marker', () => {
    expect(detectDistributionMode(appRoot())).toBe('packaged');
  });

  it('exposes the boot-time mode through application context', async () => {
    const app = await buildApp({ dataDir: appRoot() });

    expect(app.ctx.distributionMode).toBe('source');

    await app.close();
  });
});
