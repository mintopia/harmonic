/** Matches the SQLite message for a violated UNIQUE constraint, as a fallback
 * when the driver's `.code` isn't populated (e.g. wrapped errors). */
const UNIQUE_VIOLATION_MESSAGE = /UNIQUE constraint failed/;

/**
 * Detect a UNIQUE-constraint violation across both DB drivers (ADR-0029).
 * better-sqlite3 throws a `SqliteError` whose top-level `.code` is
 * `SQLITE_CONSTRAINT_UNIQUE`; drizzle-libsql wraps the driver error in a
 * `DrizzleQueryError` whose `.message` is `"Failed query: …"` (no
 * "UNIQUE constraint failed") and whose `.code` is undefined — the real code
 * (`.code === 'SQLITE_CONSTRAINT'`, `.extendedCode === 'SQLITE_CONSTRAINT_UNIQUE'`)
 * and message live on `.cause`. So walk the cause chain and check `.code`,
 * `.extendedCode`, and the message at every level.
 */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    const { code, extendedCode } = e as { code?: string; extendedCode?: string };
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || extendedCode === 'SQLITE_CONSTRAINT_UNIQUE') {
      return true;
    }
    if (UNIQUE_VIOLATION_MESSAGE.test(e.message)) return true;
  }
  return false;
}

/** Matches the SQLite message for a violated FOREIGN KEY constraint, as a
 * fallback when a wrapped error's `.code` isn't populated. */
const FOREIGN_KEY_VIOLATION_MESSAGE = /FOREIGN KEY constraint failed/;

/**
 * Detect a FOREIGN-KEY-constraint violation across both DB drivers, mirroring
 * {@link isUniqueViolation}'s cause-chain walk (ADR-0029): drizzle-libsql wraps
 * the driver error so the real `.code`/`.extendedCode`
 * (`SQLITE_CONSTRAINT`/`SQLITE_CONSTRAINT_FOREIGNKEY`) and the message live on
 * `.cause`, not the top-level `DrizzleQueryError`.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    const { code, extendedCode } = e as { code?: string; extendedCode?: string };
    if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || extendedCode === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
      return true;
    }
    if (FOREIGN_KEY_VIOLATION_MESSAGE.test(e.message)) return true;
  }
  return false;
}
