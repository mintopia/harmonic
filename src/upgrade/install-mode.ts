import { accessSync, constants, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { SYSTEMD_MIGRATION_NOTICE } from './upgrade-coordinator.js';

export type ExternalInstallSubkind = 'npx' | 'npm-global' | 'unknown';

/** How an operator manually upgrades an `external` install: an exact command to copy and run,
 * or free-text instructions when the install shape (`unknown` subkind) doesn't yield one. */
export type InstallInstruction =
  | { kind: 'command'; command: string }
  | { kind: 'manual'; instructions: string };

/** How this running instance was installed, and therefore whether/how it can self-upgrade. */
export type InstallMode =
  | { kind: 'systemd' }
  | { kind: 'initd' }
  /** A pre-versions-layout systemd unit; upgrading from the app is off until `sudo harmonic install` reinstalls it. */
  | { kind: 'migration-required' }
  /** Neither systemd nor init.d manage this process; Harmonic never self-upgrades here. */
  | { kind: 'external'; subkind: ExternalInstallSubkind; instructionFor: (version: string) => InstallInstruction };

export interface ResolveInstallModeInput {
  env: { HARMONIC_MANAGED_BY?: string | undefined };
  dataDir: string;
  cliPath: string;
  realpath: (path: string) => string;
  isWritable: (path: string) => boolean;
}

export function requiresSystemdInstallMigration({ managedBy, dataDir, cliPath }: { managedBy: string | undefined; dataDir: string; cliPath: string }): boolean {
  if (managedBy !== 'systemd') return false;
  const current = join(dataDir, 'app', 'current');
  const pathFromCurrent = relative(current, cliPath);
  return pathFromCurrent === '' || pathFromCurrent.startsWith('..') || isAbsolute(pathFromCurrent);
}

export function detectSystemdInstallMigration({
  managedBy,
  dataDir,
  cliPath,
  warn,
}: {
  managedBy: string | undefined;
  dataDir: string;
  cliPath: string;
  warn: (message: string) => void;
}): boolean {
  const migrationRequired = requiresSystemdInstallMigration({ managedBy, dataDir, cliPath });
  if (migrationRequired) warn(SYSTEMD_MIGRATION_NOTICE);
  return migrationRequired;
}

const npmGlobalPackagePath = /^(.*\/lib\/node_modules)\/@mintopia\/harmonic(\/.*)?$/;

function resolveExternalMode({ cliPath, realpath, isWritable }: Pick<ResolveInstallModeInput, 'cliPath' | 'realpath' | 'isWritable'>): InstallMode {
  let resolved: string;
  try {
    resolved = realpath(cliPath);
  } catch {
    resolved = cliPath;
  }

  if (resolved.includes('/_npx/')) {
    return { kind: 'external', subkind: 'npx', instructionFor: (version) => ({ kind: 'command', command: `npx @mintopia/harmonic@${version} serve` }) };
  }

  const npmGlobalMatch = npmGlobalPackagePath.exec(resolved);
  const nodeModulesDir = npmGlobalMatch?.[1];
  if (nodeModulesDir !== undefined) {
    return {
      kind: 'external',
      subkind: 'npm-global',
      instructionFor: (version) => ({ kind: 'command', command: `${isWritable(nodeModulesDir) ? '' : 'sudo '}npm i -g @mintopia/harmonic@${version}` }),
    };
  }

  return {
    kind: 'external',
    subkind: 'unknown',
    instructionFor: (version) => ({ kind: 'manual', instructions: `reinstall @mintopia/harmonic@${version} the way you originally installed it` }),
  };
}

export function resolveInstallMode({ env, dataDir, cliPath, realpath, isWritable }: ResolveInstallModeInput): InstallMode {
  const managedBy = env.HARMONIC_MANAGED_BY;
  if (managedBy === 'systemd') {
    return requiresSystemdInstallMigration({ managedBy, dataDir, cliPath }) ? { kind: 'migration-required' } : { kind: 'systemd' };
  }
  if (managedBy === 'initd') return { kind: 'initd' };
  return resolveExternalMode({ cliPath, realpath, isWritable });
}

export function defaultIsWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export const defaultRealpath = realpathSync;
