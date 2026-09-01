/** Compact ms → "1m 20s" / "12s". Input is always a settled
 * non-negative span; it doesn't tick. */
export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}
