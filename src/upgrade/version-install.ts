import { execFile } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const packageManifestSchema = z.object({ version: z.string() });

export type VersionInstallCommand = (command: string, args: readonly string[]) => Promise<unknown>;

export interface VersionInstallDependencies {
  run: VersionInstallCommand;
  mkdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  fileExists(path: string): boolean;
  readFile(path: string, encoding: 'utf8'): string;
  /** The symlink target at `path`, or null if it isn't a symlink (including if it doesn't exist). */
  readlink(path: string): string | null;
  /** Fsyncs a directory's own metadata so a rename inside it survives a crash. Absent ⇒ that
   * durability step is skipped (callers that don't touch a real filesystem, e.g. tests). */
  fsyncDir?(path: string): void;
}

export function readInstalledVersion({
  dir,
  readFile,
}: {
  dir: string;
  readFile: (path: string, encoding: 'utf8') => string;
}): string {
  try {
    const manifest = packageManifestSchema.parse(JSON.parse(readFile(join(dir, 'package.json'), 'utf8')));
    return manifest.version;
  } catch {
    return 'unknown';
  }
}

const readManifestVersionAt = (manifestPath: string, readFile: VersionInstallDependencies['readFile']): string => {
  try {
    return packageManifestSchema.parse(JSON.parse(readFile(manifestPath, 'utf8'))).version;
  } catch {
    return 'unknown';
  }
};

/** Reads the manifest beside `dist`'s physical location: a legacy nested-install layout can leave
 * `dir/package.json` holding npm's wrapper manifest instead of the real one. */
const manifestPathForDist = (dir: string, readlink: VersionInstallDependencies['readlink']): string => {
  const target = readlink(join(dir, 'dist'));
  if (target === null) return join(dir, 'package.json');
  const resolvedDistDir = isAbsolute(target) ? target : join(dir, target);
  return join(resolvedDistDir, '..', 'package.json');
};

export function hasValidInstall(
  dir: string,
  version: string,
  dependencies: Pick<VersionInstallDependencies, 'fileExists' | 'readFile' | 'readlink'>,
): boolean {
  if (!dependencies.fileExists(join(dir, 'dist', 'cli.js'))) return false;
  const manifestPath = manifestPathForDist(dir, dependencies.readlink);
  return readManifestVersionAt(manifestPath, dependencies.readFile) === version;
}

/**
 * Verifies a staged install before anything irreversible (the DB snapshot, the `current` flip)
 * depends on it: the manifest and `dist/cli.js` agree on the pinned version, `--version` actually
 * runs, and `dist/cli-serve.js` imports without throwing — each bounded so a hang can't block the
 * swap forever.
 */
export async function verifyInstall({
  dir,
  version,
  dependencies,
  timeoutMs = 15_000,
}: {
  dir: string;
  version: string;
  dependencies: Pick<VersionInstallDependencies, 'fileExists' | 'readFile' | 'readlink'>;
  timeoutMs?: number;
}): Promise<void> {
  if (!hasValidInstall(dir, version, dependencies)) {
    throw new Error(`installed package at ${dir} does not match pinned version ${version}`);
  }
  await execFileAsync(process.execPath, [join(dir, 'dist', 'cli.js'), '--version'], { timeout: timeoutMs });

  const cliServeUrl = pathToFileURL(join(dir, 'dist', 'cli-serve.js')).href;
  const importScript = `import(${JSON.stringify(cliServeUrl)}).then(() => process.exit(0)).catch((error) => { process.stderr.write(String(error?.stack ?? error)); process.exit(1); });`;
  await execFileAsync(process.execPath, ['-e', importScript], { timeout: timeoutMs });
}

/** Flushes the just-renamed version tree to disk before commit can depend on it surviving a
 * crash. Falls back to a bare `sync` for coreutils builds without `-f`. */
async function syncInstalledTree(run: VersionInstallCommand, versionDir: string): Promise<void> {
  try {
    await run('sync', ['-f', versionDir]);
  } catch {
    await run('sync', []);
  }
}

export async function installVersion({
  appDir,
  version,
  packageSpec,
  dependencies,
}: {
  appDir: string;
  version: string;
  packageSpec?: string;
  dependencies: VersionInstallDependencies;
}): Promise<string> {
  const versionsDir = join(appDir, 'versions');
  const versionDir = join(versionsDir, version);
  if (hasValidInstall(versionDir, version, dependencies)) return versionDir;

  const stagingDir = join(versionsDir, `.${version}.staging`);
  await dependencies.rm(stagingDir);
  await dependencies.mkdir(stagingDir);
  await dependencies.run('npm', ['pack', '--pack-destination', stagingDir, packageSpec ?? `@mintopia/harmonic@${version}`]);
  await dependencies.run('tar', ['-xzf', join(stagingDir, `mintopia-harmonic-${version}.tgz`), '--strip-components=1', '-C', stagingDir]);
  // --omit=dev still resolves the dev tree (npm crashes on its peer cycle) and runs prepare's build.
  await dependencies.run('npm', ['pkg', 'delete', 'devDependencies', 'scripts.prepare', '--prefix', stagingDir]);
  await dependencies.run('npm', ['i', '--prefix', stagingDir, '--omit=dev']);

  await dependencies.rm(versionDir);
  await dependencies.rename(stagingDir, versionDir);
  await syncInstalledTree(dependencies.run, versionDir);
  dependencies.fsyncDir?.(versionsDir);
  return versionDir;
}
