import type { StepState, WorkflowStepOutcome, WorkflowStepRun, WorkflowStepsResponse } from '../../types';
import { stateTone } from '../../attempt-timeline-model';
import { newerVersion, parseWorkflowRef } from '../../workflow-ref-model';
import { NAV_DOT, NAV_WORD, sectionCaps } from './shared';

const OUTCOME_STATE: Record<WorkflowStepOutcome, StepState> = {
  pass: 'passed',
  fail: 'failed',
  inconclusive: 'failed',
  conflict: 'failed',
  skipped: 'skipped',
};

const OUTCOME_WORD: Record<WorkflowStepOutcome, string> = {
  pass: 'passed',
  fail: 'failed',
  inconclusive: 'inconclusive',
  conflict: 'conflict',
  skipped: 'skipped',
};

function outputsSummary(step: WorkflowStepRun): string {
  const lines = step.outputs.stdout.split('\n').filter((line) => line.trim() !== '');
  const exit = step.outputs.exitCode === null ? 'no exit code' : `exit ${step.outputs.exitCode}`;
  if (lines.length === 0) return `${exit} · no output`;
  return `${exit} · ${lines.length} line${lines.length === 1 ? '' : 's'} · last: ${lines[lines.length - 1]}`;
}

function StepRow({ step }: { step: WorkflowStepRun }) {
  const state: StepState = step.outcome === null ? 'running' : OUTCOME_STATE[step.outcome];
  const tone = stateTone(state);
  const word = step.outcome === null ? 'running' : OUTCOME_WORD[step.outcome];
  return (
    <li className="rounded-lg border border-hairline bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink">
          <span className="font-data text-[12.5px]">{step.stepId}</span>
          <span className="ml-1 font-normal text-faint">· {step.action}</span>
        </span>
        <span className={`inline-flex items-center gap-1.5 text-[12px] font-semibold ${NAV_WORD[tone]}`}>
          <span role="img" aria-label={word} className={`size-2 rounded-full ${NAV_DOT[tone]}`} />
          {word}
        </span>
      </div>
      {step.summary && <p className="mt-2 whitespace-pre-wrap break-words text-[13px] text-muted">{step.summary}</p>}
      {step.resolvedPrompt !== null && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[12px] font-semibold text-muted">Resolved Prompt</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-data text-[12px] text-ink">{step.resolvedPrompt}</pre>
        </details>
      )}
      {step.outcome !== null && step.outcome !== 'skipped' && <p className="mt-2 break-words font-data text-[12px] text-faint">{outputsSummary(step)}</p>}
    </li>
  );
}

export function groupByAttempt(steps: WorkflowStepRun[]): { attempt: number | null; firstIndex: number; steps: WorkflowStepRun[] }[] {
  const groups: { attempt: number | null; firstIndex: number; steps: WorkflowStepRun[] }[] = [];
  for (const [index, step] of steps.entries()) {
    const last = groups.at(-1);
    if (last && last.attempt === step.attempt) last.steps.push(step);
    else groups.push({ attempt: step.attempt, firstIndex: index, steps: [step] });
  }
  return groups;
}

function headerText(ref: string, latestVersion: number | null): string {
  const { name, version } = parseWorkflowRef(ref);
  const head = version === null ? name : `${name} v${version}`;
  const newer = newerVersion(ref, latestVersion);
  return newer === null ? head : `${head} · snapshotted v${version}; v${newer} exists and applies from the next Retry`;
}

export function WorkflowSteps({ data }: { data: WorkflowStepsResponse | null }) {
  if (!data?.workflowRef) return null;
  return (
    <section aria-label="Task Execution Workflow steps" className="mt-5">
      <div className="mb-2 flex items-center gap-2">
        <h3 className={sectionCaps}>Steps</h3>
        <span className="text-[12px] text-muted">{headerText(data.workflowRef, data.latestVersion)}</span>
      </div>
      {data.steps.length === 0 ? (
        <p className="text-[13px] text-muted">No step has run yet.</p>
      ) : (
        <div className="space-y-4">
          {groupByAttempt(data.steps).map((group) => (
            <div key={`${group.attempt ?? 'outside'}:${group.firstIndex}`}>
              {group.attempt !== null && <h4 className="mb-2 text-[12px] font-semibold text-muted">Attempt {group.attempt}</h4>}
              <ol className="space-y-2">
                {group.steps.map((step, index) => (
                  <StepRow key={`${step.stepId}:${index}`} step={step} />
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
