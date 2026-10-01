import type { ChildProcess } from 'node:child_process';

/** Resolves once `child` has exited (or failed to spawn); immediately if it already has. */
export function childExited(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
}
