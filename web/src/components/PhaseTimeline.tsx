import { fmtDuration, type PhaseStep } from '../phase-timeline-model';
import { labelType } from '../ui';

/** Short label per phase (issue #171) — the compact stepper needs a word
 * that fits a small pill, not the raw machine token. */
const PHASE_LABELS: Record<PhaseStep['phase'], string> = {
  executing: 'Executing',
  validating: 'Validating',
  verifying: 'Verifying',
  review: 'Review',
  landing: 'Merging',
  terminal: 'Done',
};

function dotClass(step: PhaseStep): string {
  if (step.status === 'current') {
    return step.phase === 'review' ? 'bg-await-dot' : 'bg-accent motion-safe:animate-pulse';
  }
  if (step.status === 'done') return 'bg-accent';
  // 'gap' is hollow, not filled — the run passed through, but no event
  // proves it, so the dot only outlines the pending-phase slot rather than
  // filling it (issue #176). Deliberately not a new color: the same faint
  // ring pending already uses, just drawn as a ring instead of a fill.
  if (step.status === 'gap') return 'bg-transparent ring-1 ring-inset ring-faint';
  return 'bg-faint';
}

function textClass(step: PhaseStep): string {
  if (step.status === 'current') return step.phase === 'review' ? 'text-await' : 'text-accent';
  if (step.status === 'done') return 'text-muted';
  // 'gap' reads a touch stronger than 'pending' (text-faint) — it's a note
  // about missing data, not silence, but still no alarm color (issue #176).
  if (step.status === 'gap') return 'text-muted';
  return 'text-faint';
}

/** Phase label plus, for a gap, why it's drawn hollow (issue #176) — the
 * tooltip is the one place that spells out "no event", so the dot/label
 * pair doesn't need its own alarming color to carry that meaning. */
function titleFor(step: PhaseStep): string {
  const label = PHASE_LABELS[step.phase];
  if (step.status === 'gap') return `${label} — no phase event recorded`;
  if (step.at) return `${label} — ${new Date(step.at).toLocaleTimeString()}`;
  return label;
}

/**
 * A compact horizontal stepper over the Run phase machine (issue #171): a
 * dot + label per `RUN_PHASES` entry, filled/accent once entered, pulsing
 * accent for the live phase, faint/muted for anything not yet reached, and
 * (issue #176) a hollow ring for a phase the run must have passed through
 * but whose own event never arrived — visually distinct from a genuinely
 * not-yet-reached phase, without borrowing an alarm color for a data-honesty
 * note. Each entered phase's duration, when known, renders as a small
 * tabular-nums figure beside its label. `phaseTimelineFromEvents` (pure
 * model) derives `steps`; this component only renders them — no state, no
 * fetch.
 */
export function PhaseTimeline({ steps }: { steps: PhaseStep[] }) {
  return (
    <ol aria-label="Run phase timeline" className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {steps.map((step, i) => (
        <li key={step.phase} className="flex items-center gap-1">
          <span aria-hidden className={`size-[7px] shrink-0 rounded-full ${dotClass(step)}`} />
          <span title={titleFor(step)} className={`${labelType} ${textClass(step)}`}>
            {PHASE_LABELS[step.phase]}
          </span>
          {/* A duration is a figure, not code — sans + tabular-nums, never the
              mono data face (DESIGN.md, the Mono Is Code Rule). The model already
              reports an out-of-order (negative) span as null, so no guard here. */}
          {step.durationMs != null && (
            <span className="text-small tabular-nums text-faint">{fmtDuration(step.durationMs)}</span>
          )}
          {i < steps.length - 1 && <span aria-hidden className="mx-1 h-px w-3 bg-faint" />}
        </li>
      ))}
    </ol>
  );
}
