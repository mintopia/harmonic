/**
 * The wall-clock countdown the Ticket header shows for a working Task: how
 * long remains before its Attempt's wall-clock guardrail trips. Pure so the
 * formatting is unit-testable without a clock or a render.
 */
export interface WallClockRemaining {
  /** e.g. "42m left", "1h 05m left", "0m left". */
  label: string;
  /** True once `now` has reached or passed `deadline` — the guardrail may trip any moment. */
  overdue: boolean;
}

/** The remaining time to `deadline` as of `now`, rounded up to the minute so a
 * countdown never reads "0m left" while time still remains. */
export function wallClockRemaining(deadline: number, now: number): WallClockRemaining {
  const remainingMs = deadline - now;
  const overdue = remainingMs <= 0;
  const totalMinutes = overdue ? 0 : Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const label = hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m left` : `${minutes}m left`;
  return { label, overdue };
}
