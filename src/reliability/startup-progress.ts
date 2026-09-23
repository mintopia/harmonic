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

let bootProgressDataDir: string | undefined;
let lastThrottledTouchAt = 0;
const THROTTLED_TOUCH_INTERVAL_MS = 2000;

/**
 * Marks boot as in progress so every {@link yieldToEventLoop} call (and so every
 * `forEachYielding` loop, which every growing-collection boot loop already uses per
 * AGENTS.md's "Background loops must yield") touches startup progress while it runs, not just
 * around whole boot phases. Always pair with {@link endBootProgress}.
 */
export function beginBootProgress(dataDir: string): void {
  bootProgressDataDir = dataDir;
  lastThrottledTouchAt = 0;
}

export function endBootProgress(): void {
  bootProgressDataDir = undefined;
}

/** Throttled to {@link THROTTLED_TOUCH_INTERVAL_MS} so calling it on every yield stays cheap. No-op unless a boot is in progress. */
export function touchStartupProgressIfBooting(now: () => number = Date.now): void {
  if (!bootProgressDataDir) return;
  const at = now();
  if (at - lastThrottledTouchAt < THROTTLED_TOUCH_INTERVAL_MS) return;
  lastThrottledTouchAt = at;
  touchStartupProgress(bootProgressDataDir);
}
