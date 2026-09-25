export interface WallClockRemaining {
  label: string;
  overdue: boolean;
}

/** Rounds up so it never reads "0m left" while time remains. */
export function wallClockRemaining(deadline: number, now: number): WallClockRemaining {
  const remainingMs = deadline - now;
  const overdue = remainingMs <= 0;
  if (overdue) return { label: 'Overdue', overdue };
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const label = hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m left` : `${minutes}m left`;
  return { label, overdue };
}
