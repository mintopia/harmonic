import type { PhaseStep } from '../phase-timeline-model';
import { labelType } from '../ui';

/** Short label per phase (issue #171) — the compact stepper needs a word
 * that fits a small pill, not the raw machine token. */
const PHASE_LABELS: Record<PhaseStep['phase'], string> = {
  executing: 'Executing',
  validating: 'Validating',
  verifying: 'Verifying',
  review: 'Review',
  landing: 'Landing',
  terminal: 'Done',
};

function dotClass(status: PhaseStep['status']): string {
  if (status === 'current') return 'bg-accent motion-safe:animate-pulse';
  if (status === 'done') return 'bg-accent';
  return 'bg-faint';
}

function textClass(status: PhaseStep['status']): string {
  if (status === 'current') return 'text-accent';
  if (status === 'done') return 'text-muted';
  return 'text-faint';
}

/**
 * A compact horizontal stepper over the Run phase machine (issue #171): a
 * dot + label per `RUN_PHASES` entry, filled/accent once entered, pulsing
 * accent for the live phase, and faint/muted for anything not yet reached.
 * `phaseTimelineFromEvents` (pure model) derives `steps`; this component only
 * renders them — no state, no fetch.
 */
export function PhaseTimeline({ steps }: { steps: PhaseStep[] }) {
  return (
    <ol aria-label="Run phase timeline" className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {steps.map((step, i) => (
        <li key={step.phase} className="flex items-center gap-1">
          <span
            aria-hidden
            className={`size-[7px] shrink-0 rounded-full ${dotClass(step.status)}`}
          />
          <span
            title={step.at ? `${PHASE_LABELS[step.phase]} — ${new Date(step.at).toLocaleTimeString()}` : PHASE_LABELS[step.phase]}
            className={`${labelType} ${textClass(step.status)}`}
          >
            {PHASE_LABELS[step.phase]}
          </span>
          {i < steps.length - 1 && <span aria-hidden className="mx-1 h-px w-3 bg-faint" />}
        </li>
      ))}
    </ol>
  );
}
