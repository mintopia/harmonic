/**
 * Extract the holder Task id from a lease skip-reason string (issue #176),
 * e.g. "Work Context held by task #12 (running)" -> 12. The server format is
 * fixed at `src/execution/auto-runner.ts` (`skipReasonFor`); this just reads
 * the `task #<id>` pattern back out so the caller can link it. Total: never
 * throws, returns `null` for anything that doesn't match (including `null`
 * or empty input).
 */
export function parseSkipReasonTaskRef(skipReason: string | null): number | null {
  if (!skipReason) return null;
  const match = skipReason.match(/task #(\d+)/);
  if (!match) return null;
  return Number(match[1]);
}
