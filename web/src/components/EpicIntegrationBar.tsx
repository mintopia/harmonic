import type { Epic, IntegrationStepState } from '../epic-model';
import { integrationSteps } from '../epic-model';
import { sectionLabel } from '../ui';

const STEP_FILL: Record<IntegrationStepState, string> = {
  done: 'bg-merged-dot',
  current: 'bg-running-dot',
  held: 'bg-await-dot motion-safe:animate-pulse',
  pending: 'bg-edge',
};
const STEP_TEXT: Record<IntegrationStepState, string> = {
  done: 'text-merged',
  current: 'text-running',
  held: 'text-await',
  pending: 'text-faint',
};

/** The whole-Epic integration progress bar (verify → merge →
 * post-merge check → retire), shown once the Epic reaches the gate. Shared
 * by the Board surface and the Epic summary page so both
 * render the same server-authoritative bar without drift. */
export function EpicIntegrationBar({ epic }: { epic: Epic }) {
  const steps = integrationSteps(epic);
  const current = steps.find((s) => s.state === 'current' || s.state === 'held');
  return (
    <div className="border-t border-hairline px-4 py-3">
      <div className={sectionLabel}>Integration</div>
      <ol
        className="mt-2.5 flex items-center gap-2"
        aria-label={`Integration progress — ${current ? current.label : 'complete'}${epic.integrate.held != null ? ' (escalated)' : ''}`}
      >
        {steps.map((step, i) => (
          <li key={step.key} className="flex flex-1 items-center gap-2 last:flex-none">
            <span className="flex items-center gap-1.5 whitespace-nowrap" title={step.disabled ? 'Not configured' : undefined}>
              <span aria-hidden="true" className={`size-2.5 rounded-full ${step.disabled ? STEP_FILL.pending : STEP_FILL[step.state]}`} />
              <span className={`text-small font-medium ${step.disabled ? STEP_TEXT.pending : STEP_TEXT[step.state]}`}>{step.label}</span>
            </span>
            {i < steps.length - 1 && <span aria-hidden="true" className="h-px flex-1 bg-edge" />}
          </li>
        ))}
      </ol>
    </div>
  );
}
