import type { Task } from '../types';

export function WaitChip({ label, off = false, tip }: { label: string; off?: boolean; tip?: { title: string; body: string } }) {
  return (
    <span
      data-testid="target-wait-chip"
      tabIndex={tip ? 0 : undefined}
      className={`group/wait relative inline-flex ${tip ? 'cursor-help' : ''} items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${off ? 'bg-raised text-muted' : 'bg-ready-tint text-ready ring-1 ring-ready-dot/30'}`}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {label}
      {tip && (
        <span
          role="tooltip"
          className="pointer-events-none invisible absolute left-0 top-[calc(100%+8px)] z-10 w-72 whitespace-normal rounded bg-surface px-3 py-2.5 text-[12px] font-normal normal-case leading-[1.45] text-ink opacity-0 shadow-float group-hover/wait:visible group-hover/wait:opacity-100 group-focus/wait:visible group-focus/wait:opacity-100"
        >
          <b className="font-semibold">{tip.title}</b>
          <br />
          {tip.body}
        </span>
      )}
    </span>
  );
}

export function TargetWaitChip({ wait }: { wait: Task['targetWait'] }) {
  if (!wait) return null;
  const tip = wait.disabled
    ? { title: `${wait.target} is disabled`, body: 'Tickets wait until it is re-enabled.' }
    : { title: `${wait.target} is at its concurrency limit`, body: 'This Ticket starts when a running one finishes.' };
  return <WaitChip label={`waiting for ${wait.target}`} off={wait.disabled} tip={tip} />;
}

export function ordinal(n: number): string {
  const rest = n % 100;
  const suffix = rest >= 11 && rest <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

export function TargetWaitProps({ wait }: { wait: NonNullable<Task['targetWait']> }) {
  const rows = [
    ['Target', <><code className="rounded-full bg-ready-tint px-2 py-0.5 font-data text-[11px] font-semibold text-ready">{wait.target}</code>{wait.limit != null && <span className="ml-2 text-[12px] text-muted">{wait.running}/{wait.limit} running</span>}</>],
    ['Position', `${ordinal(wait.position)} in line`],
    ['Starts', wait.disabled ? `when ${wait.target} is re-enabled` : 'when a running Ticket finishes'],
  ] as const;
  return (
    <dl className="mt-3 grid grid-cols-3 gap-4 max-sm:grid-cols-1">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-label font-semibold uppercase text-faint">{label}</dt>
          <dd className="m-0 mt-0.5 text-small">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
