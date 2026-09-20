import { logger } from './logger.js';
import { DomainError } from './domain/errors.js';

/**
 * Why an operation produced no value: the thing genuinely is not there
 * (an expected absence) versus the operation itself broke (a real failure).
 * Every migrated swallow-site records exactly one of these.
 */
export type FailureKind = 'not-found' | 'failed';

/** The scalar attributes a log line carries, matching {@link logger}'s shape. */
export type FailureContext = Record<string, string | number | boolean | undefined>;

/** How one swallow-site describes itself to the log. */
export interface FailureReport {
  /** Stable dotted slug naming the operation, e.g. `runner.persistSession`. Greppable and alertable. */
  op: string;
  /** Identifiers that make the line diagnosable: taskId, attemptId, repoDir, … */
  context?: FailureContext;
  /** Level for a real failure. Defaults to `error`. */
  level?: 'debug' | 'info' | 'warn' | 'error';
  /** Level for an expected absence. Defaults to `debug`. */
  notFoundLevel?: 'debug' | 'info' | 'warn';
  /**
   * An extra test for "this error is a legitimate absence, not a failure",
   * layered on top of the built-in `DomainError('not_found')` check — for
   * absences that arrive as an ENOENT, a git `unknown revision`, or a 404.
   */
  notFoundIf?: (err: unknown) => boolean;
}

/** A classified, already-logged failure. `error` is the original, unwrapped. */
export interface Failure {
  ok: false;
  kind: FailureKind;
  message: string;
  error: unknown;
}

/** A value, or the {@link Failure} that replaced it. */
export type Attempted<T> = { ok: true; value: T } | Failure;

/** The repo's existing `err instanceof Error ? err.message : String(err)` idiom, once. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function classify(err: unknown, report: FailureReport): FailureKind {
  if (err instanceof DomainError && err.code === 'not_found') return 'not-found';
  return report.notFoundIf?.(err) === true ? 'not-found' : 'failed';
}

/**
 * Log a swallowed error with enough context to diagnose it, and hand back a
 * typed failure. Never throws. An expected absence is tagged `not-found` and
 * logged quietly; anything else is a real failure at the site's chosen level.
 */
export function reportFailure(err: unknown, report: FailureReport): Failure {
  const kind = classify(err, report);
  const message = errorMessage(err);
  const level = kind === 'not-found' ? (report.notFoundLevel ?? 'debug') : (report.level ?? 'error');
  logger[level](kind === 'not-found' ? `${report.op}: nothing found` : `${report.op} failed`, {
    ...report.context,
    op: report.op,
    outcome: kind,
    error: message,
  });
  return { ok: false, kind, message, error: err };
}

/** {@link reportFailure} for a caller that must still see the failure: record the context here, rethrow the original error unchanged. */
export function reportAndRethrow(err: unknown, report: FailureReport): never {
  reportFailure(err, report);
  throw err;
}

/** Run `op`, returning its value or a logged {@link Failure} — the structured form, for callers that branch on `not-found` versus `failed`. */
export async function attempted<T>(op: () => T | Promise<T>, report: FailureReport): Promise<Attempted<T>> {
  try {
    return { ok: true, value: await op() };
  } catch (err) {
    return reportFailure(err, report);
  }
}

/** Run `op`, falling back to `fallback` on failure — the logged replacement for `.catch(() => null)` and its siblings. */
export async function orFallback<T, F = T>(op: () => T | Promise<T>, report: FailureReport, fallback: F): Promise<T | F> {
  const result = await attempted(op, report);
  return result.ok ? result.value : fallback;
}

/** Await `op` for its side effect only, reporting `true` when it landed — the logged replacement for a bare try/await with a silently-swallowed failure. */
export async function bestEffort(op: () => unknown | Promise<unknown>, report: FailureReport): Promise<boolean> {
  return (await attempted(op, report)).ok;
}

/** Start `op` and return immediately, logging any rejection — the logged replacement for firing a promise and silently discarding its rejection. */
export function fireAndForget(op: () => unknown | Promise<unknown>, report: FailureReport): void {
  void (async () => {
    try {
      await op();
    } catch (err) {
      reportFailure(err, report);
    }
  })();
}
