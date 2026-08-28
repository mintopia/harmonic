/**
 * Process-level unhandled-rejection safety net (issue #371).
 *
 * The runner fire-and-forgets promises on its hottest paths (e.g. run-event
 * appends). Each such site owns its own `.catch`, but a future miss would reach
 * Node's default `unhandledRejection` behaviour — terminating the process. This
 * installs a last-resort handler that logs the rejection as a legible error,
 * with Run/Task context when the rejected value carries it, instead of letting
 * it be fatal.
 *
 * It is a backstop, not a substitute for per-site handling: a rejection that
 * reaches here is a bug to fix, but it degrades to a logged event, not a crash.
 */
import { logger } from '../logger.js';

export interface RejectionContext {
  taskId?: number;
  runId?: number;
}

/** The slice of `process` this needs, so tests can inject a bare emitter. */
export interface RejectionEmitter {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
}

export interface ProcessSafetyNetOptions {
  /** Sink for a caught rejection. Default: the shared logger at error level. */
  onUnhandledRejection?: (reason: unknown, context: RejectionContext) => void;
  /** Emitter to attach to. Default: the global `process`. Injected in tests. */
  target?: RejectionEmitter;
}

/** Pull Run/Task ids off a rejected value when it carries them. */
export function rejectionContext(reason: unknown): RejectionContext {
  if (typeof reason !== 'object' || reason === null) return {};
  const { taskId, runId } = reason as { taskId?: unknown; runId?: unknown };
  return {
    ...(typeof taskId === 'number' ? { taskId } : {}),
    ...(typeof runId === 'number' ? { runId } : {}),
  };
}

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? reason.message;
  return String(reason);
}

function defaultReport(reason: unknown, context: RejectionContext): void {
  logger.error(`unhandled rejection (non-fatal): ${describe(reason)}`, { ...context });
}

/**
 * Install the last-resort unhandled-rejection handler. Returns an uninstaller
 * that removes it again (used by tests; the server keeps it for its whole life).
 */
export function installProcessSafetyNet(options: ProcessSafetyNetOptions = {}): () => void {
  const target = options.target ?? process;
  const report = options.onUnhandledRejection ?? defaultReport;
  const handler = (reason: unknown): void => {
    report(reason, rejectionContext(reason));
  };
  target.on('unhandledRejection', handler);
  return () => {
    target.off('unhandledRejection', handler);
  };
}
