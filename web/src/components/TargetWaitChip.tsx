import { parseTargetWait } from '../skip-reason-model';

export function TargetWaitChip({ skipReason }: { skipReason: string | null }) {
  const wait = parseTargetWait(skipReason);
  if (!wait) return null;
  const tip = wait.disabled ? `${wait.target} is disabled. Tickets wait until it is re-enabled.` : `${wait.target} is at its concurrency limit. This Ticket starts when a running one finishes.`;
  return (
    <span
      data-testid="target-wait-chip"
      tabIndex={0}
      title={tip}
      className={`inline-flex cursor-help items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${wait.disabled ? 'bg-raised text-muted' : 'bg-ready-tint text-ready'}`}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      waiting for {wait.target}
    </span>
  );
}
