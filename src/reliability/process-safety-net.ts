import { logger } from '../logger.js';

export interface RejectionContext {
  taskId?: number;
  attemptId?: number;
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

/** Pull Attempt/Task ids off a rejected value when it carries them. */
export function rejectionContext(reason: unknown): RejectionContext {
  if (typeof reason !== 'object' || reason === null) return {};
  const { taskId, attemptId } = reason as { taskId?: unknown; attemptId?: unknown };
  return {
    ...(typeof taskId === 'number' ? { taskId } : {}),
    ...(typeof attemptId === 'number' ? { attemptId } : {}),
  };
}

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? reason.message;
  return String(reason);
}

function defaultReport(reason: unknown, context: RejectionContext): void {
  logger.error(`unhandled rejection (non-fatal): ${describe(reason)}`, { ...context });
}

/** Install the last-resort unhandled-rejection handler; returns an uninstaller. */
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
