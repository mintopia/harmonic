import { closeSync, existsSync, openSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

export function startupProgressPath(dataDir: string): string {
  return join(dataDir, 'app', 'startup-progress');
}

/** The out-of-process startup watcher measures its kill deadline from this file's mtime, not its own spawn time, so a slow-but-progressing boot is never killed. No-op outside a managed install. */
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
      // best-effort; the watcher falls back to its own start time if this file never appears
    }
  }
}

let bootProgressDataDir: string | undefined;
let lastThrottledTouchAt = 0;
const THROTTLED_TOUCH_INTERVAL_MS = 2000;

/** While set, every {@link yieldToEventLoop} call touches startup progress, not just whole boot phases. Always pair with {@link endBootProgress}. */
export function beginBootProgress(dataDir: string): void {
  bootProgressDataDir = dataDir;
  lastThrottledTouchAt = 0;
}

export function endBootProgress(): void {
  bootProgressDataDir = undefined;
}

export function touchStartupProgressIfBooting(now: () => number = Date.now): void {
  if (!bootProgressDataDir) return;
  const at = now();
  if (at - lastThrottledTouchAt < THROTTLED_TOUCH_INTERVAL_MS) return;
  lastThrottledTouchAt = at;
  touchStartupProgress(bootProgressDataDir);
}
