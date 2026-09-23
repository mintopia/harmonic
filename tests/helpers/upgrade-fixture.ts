import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function createTempDirTracker(): { tempDir(prefix: string): string; cleanupAll(): void } {
  const cleanup: string[] = [];
  return {
    tempDir(prefix: string): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      cleanup.push(dir);
      return dir;
    },
    cleanupAll(): void {
      for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface FixturePackageOptions {
  version: string;
  cliJs?: string;
  cliServeJs?: string;
  files?: Record<string, string>;
  scripts?: Record<string, string>;
}

/**
 * Builds a real npm-pack-shaped tarball fixture on disk, without running its own `prepare` script
 * (packing a local directory with `npm pack <dir>` would run `prepare` immediately).
 */
export function packFixtureTarball(tempDir: (prefix: string) => string, options: FixturePackageOptions): string {
  const { version, cliJs, cliServeJs, files, scripts } = options;
  const source = tempDir('harmonic-upgrade-fixture-src-');
  const packageDir = join(source, 'package');
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(
    join(packageDir, 'dist', 'cli.js'),
    cliJs ?? `#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }\nconsole.log("fixture-cli");\n`,
  );
  writeFileSync(join(packageDir, 'dist', 'cli-serve.js'), cliServeJs ?? 'export {};\n');
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@mintopia/harmonic',
    version,
    type: 'module',
    devDependencies: { 'nonexistent-dev-dep': '999.999.999' },
    scripts: { prepare: 'exit 1', ...scripts },
  }));
  for (const [relativePath, contents] of Object.entries(files ?? {})) {
    const fullPath = join(packageDir, relativePath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, contents);
  }
  const tarballDir = tempDir('harmonic-upgrade-fixture-tgz-');
  const tarballPath = join(tarballDir, `mintopia-harmonic-${version}.tgz`);
  execFileSync('tar', ['-czf', tarballPath, '-C', source, 'package']);
  return tarballPath;
}
