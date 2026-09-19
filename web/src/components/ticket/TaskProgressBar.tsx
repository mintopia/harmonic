import { Icon } from '../Icon';
import type { AttemptSummary, Task } from '../../types';
import { card, PHASE_NODE_STYLES } from '../../ui';
import { splitPathTail } from '../../path';
import { taskLifecycle, type LifecycleStepKey, type LifecycleStepStatus } from '../../task-detail-model';
import { sectionCaps } from './shared';

function stepGlyph(status: LifecycleStepStatus, index: number) {
  if (status === 'done') return <Icon name="check" className="size-3.5" />;
  if (status === 'failed') return <Icon name="close" className="size-3.5" />;
  return <span>{index + 1}</span>;
}

const STEP_LABEL_TONE: Record<LifecycleStepStatus, string> = {
  done: 'text-muted',
  current: 'text-accent',
  awaiting: 'text-await',
  pending: 'text-faint',
  failed: 'text-fail',
};

const STEP_STATUS_LABEL: Record<LifecycleStepStatus, string> = {
  done: 'completed',
  current: 'in progress',
  awaiting: 'awaiting review',
  pending: 'pending',
  failed: 'failed',
};

function stepCaption(key: LifecycleStepKey, status: LifecycleStepStatus, task: Task, attemptCount: number, disabled: boolean): string | null {
  switch (key) {
    case 'worktree':
      return task.branch ? splitPathTail(task.branch).tail : null;
    case 'implementation':
      return attemptCount > 0 ? `${attemptCount} attempt${attemptCount === 1 ? '' : 's'}` : null;
    case 'merge':
      return status === 'awaiting' ? 'awaiting review' : null;
    case 'postMergeCheck':
      return disabled ? 'not configured' : 'revert on red';
    case 'closeIssue':
      return task.trackerRef != null ? `#${task.trackerRef}` : null;
    case 'retire':
      return 'cleanup';
  }
}

function TaskProgressBar({ task, attempts, commandConfigured }: { task: Task; attempts: AttemptSummary[]; commandConfigured: boolean }) {
  const { steps } = taskLifecycle(task.state, attempts, commandConfigured, task.mergeStatus);
  return (
    <div className="mb-6 mt-1">
      <div className={`mb-3 ${sectionCaps}`}>Task progress</div>
      <ol
        className={`${card} flex items-start px-[22px] py-5 max-md:flex-col max-md:items-stretch max-md:gap-3 max-md:px-4`}
        aria-label="Task progress"
      >
        {steps.map((step, i) => {
          // `disabled` steps (e.g. an unconfigured post-merge check) are still
          // reachable, not skipped, so their `status` alone — not `disabled` —
          // decides whether a connector is solid.
          const leftConnectorSolid = i > 0 && steps[i - 1]?.status === 'done';
          const rightConnectorSolid = step.status === 'done';
          const caption = stepCaption(step.key, step.status, task, attempts.length, !!step.disabled);
          return (
            <li
              key={step.key}
              aria-current={step.status === 'current' || step.status === 'awaiting' ? 'step' : undefined}
              className="flex min-w-0 flex-1 flex-col items-center gap-2 text-center max-md:w-full max-md:flex-none max-md:flex-row max-md:items-center max-md:gap-3 max-md:text-left"
            >
              <div className="flex w-full items-center max-md:w-auto max-md:flex-none">
                <span className={`-mx-px h-0.5 flex-1 rounded max-md:hidden ${i === 0 ? 'invisible' : leftConnectorSolid ? 'bg-merged' : 'bg-edge'}`} />
                <span
                  className={`flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold tabular-nums ${PHASE_NODE_STYLES[step.status]} ${step.disabled ? 'opacity-60' : ''}`}
                >
                  {stepGlyph(step.status, i)}
                </span>
                <span className={`-mx-px h-0.5 flex-1 rounded max-md:hidden ${i === steps.length - 1 ? 'invisible' : rightConnectorSolid ? 'bg-merged' : 'bg-edge'}`} />
              </div>
              <div className="contents max-md:flex max-md:min-w-0 max-md:flex-col">
                <span className={`text-[12px] font-semibold leading-tight ${step.disabled ? 'text-faint' : STEP_LABEL_TONE[step.status]}`}>
                  {step.label}
                  <span className="sr-only"> — {step.disabled ? 'not configured' : STEP_STATUS_LABEL[step.status]}</span>
                </span>
                {caption && <span className="text-[10.5px] leading-tight text-faint">{caption}</span>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export { TaskProgressBar };
