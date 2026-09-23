import { closeSync, existsSync, openSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

export function startupProgressPath(dataDir: string): string {
  return join(dataDir, 'app', 'startup-progress');
}

/**
 * Marks that boot is still making progress: the out-of-process startup watcher (`startup-watcher.cjs`)
 * measures its deadline from this file's mtime instead of from its own spawn time, so a release whose
 * migrations legitimately take longer than one deadline window isn't killed as long as it keeps
 * touching this between phases. A no-op outside a managed (`systemd`/`initd`) install — `app/` only
 * exists there, and nothing reads this file otherwise.
 */
export function touchStartupProgress(dataDir: string): void {
  const appDir = join(dataDir, 'app');
  if (!existsSync(appDir)) return;
  const path = startupProgressPath(dataDir);
  const now = new Date();
  try {
    utimesSync(path, now, now);
  } catch {
    try {
      closeSync(openSync(path, 'a'));
    } catch {
      // best-effort: the watcher falls back to its own start time if this file never appears
    }
  }
}
