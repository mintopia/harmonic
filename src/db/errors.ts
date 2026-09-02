/** SQLite's message for a violated UNIQUE constraint; the fallback when a wrapped error's `.code` isn't populated. */
const UNIQUE_VIOLATION_MESSAGE = /UNIQUE constraint failed/;

/** Detect a UNIQUE-constraint violation. drizzle-libsql wraps the driver error in a `DrizzleQueryError` with no `.code`; the real `.code`/`.extendedCode` and message live on `.cause`, so walk the chain. */
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

/** SQLite's message for a violated FOREIGN KEY constraint; the fallback when a wrapped error's `.code` isn't populated. */
const FOREIGN_KEY_VIOLATION_MESSAGE = /FOREIGN KEY constraint failed/;

/** Detect a FOREIGN-KEY-constraint violation, walking the cause chain like {@link isUniqueViolation}. */
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
