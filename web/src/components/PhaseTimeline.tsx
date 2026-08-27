import { fmtDuration, type PhaseStep } from '../phase-timeline-model';
import { labelType } from '../ui';

const PHASE_LABELS: Record<PhaseStep['phase'], string> = {
  executing: 'Executing',
  validating: 'Validating',
  verifying: 'Verifying',
  merging: 'Merging',
  terminal: 'Done',
};

function dotClass(step: PhaseStep): string {
  if (step.status === 'current') return 'bg-accent motion-safe:animate-pulse';
  if (step.status === 'done') return 'bg-accent';
  if (step.status === 'gap') return 'bg-transparent ring-1 ring-inset ring-faint';
  return 'bg-faint';
}

function textClass(step: PhaseStep): string {
  if (step.status === 'current') return 'text-accent';
  if (step.status === 'done') return 'text-muted';
  if (step.status === 'gap') return 'text-muted';
  return 'text-faint';
}

function titleFor(step: PhaseStep): string {
  const label = PHASE_LABELS[step.phase];
  if (step.status === 'gap') return `${label} — no phase event recorded`;
  if (step.at) return `${label} — ${new Date(step.at).toLocaleTimeString()}`;
  return label;
}

export function PhaseTimeline({ steps }: { steps: PhaseStep[] }) {
  return (
    <ol aria-label="Run phase timeline" className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {steps.map((step, i) => (
        <li key={step.phase} className="flex items-center gap-1">
          <span aria-hidden className={`size-[7px] shrink-0 rounded-full ${dotClass(step)}`} />
          <span title={titleFor(step)} className={`${labelType} ${textClass(step)}`}>
            {PHASE_LABELS[step.phase]}
          </span>
          {step.durationMs != null && (
            <span className="text-small tabular-nums text-faint">{fmtDuration(step.durationMs)}</span>
          )}
          {i < steps.length - 1 && <span aria-hidden className="mx-1 h-px w-3 bg-faint" />}
        </li>
      ))}
    </ol>
  );
}
