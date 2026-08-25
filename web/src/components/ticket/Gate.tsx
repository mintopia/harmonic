import { currentRunId } from '../../run-rail-model';
import type { RunDot } from '../../run-rail-model';
import type { GateModel } from '../../ticket-gate-model';
import { formatCost } from '../../cost';
import type { Run, Task, VerificationAttempt } from '../../types';
import { btnGhost, dot, runDotFill } from '../../ui';
import { taskActions } from '../../task-actions-model';
import { TaskActions } from '../TaskActions';

const DOT_LABEL: Record<RunDot, string> = {
  running: 'running',
  fail: 'failed',
  merged: 'merged',
  review: 'awaiting review',
  neutral: 'neutral',
};

// Extra bottom clearance so the sacred gate buttons are never covered by the
// collapsed Conversation launcher tab that floats in the bottom-right corner.
const WRAP = 'sticky bottom-0 z-[5] flex flex-col gap-2.5 border-t border-hairline bg-surface px-3.5 pt-3.5 pb-12 shadow-float';

export function Gate({
  model,
  task,
  runs,
  verificationAttempts,
  onEdit,
  onChanged,
  onGoToCurrent,
}: {
  model: GateModel;
  task: Task;
  runs: Run[];
  verificationAttempts: VerificationAttempt[];
  onEdit: (task: Task) => void;
  onChanged: () => void;
  onGoToCurrent: (runId: number) => void;
}) {
  // No run to gate (a fresh re-attempt, or an uncancelled/ready Task that hasn't
  // run yet): the review gate below only mounts while a current run exists, so a
  // run-less Task would otherwise have NO state actions on its detail page —
  // no way to cancel, delete, run, or edit it. Surface those here. TaskActions
  // (footer) self-hides when the state has none, so guard the wrap on that.
  if (model.kind === 'none') {
    if (taskActions(task.state).length === 0) return null;
    return (
      <div className={WRAP}>
        <TaskActions task={task} variant="footer" onEdit={onEdit} onChanged={onChanged} />
      </div>
    );
  }

  if (model.kind === 'result') {
    const lead = `Run ${model.attempt} `;
    const rest = model.summary.startsWith(lead) ? model.summary.slice(lead.length) : model.summary;
    return (
      <div className={WRAP}>
        <div className="flex items-center justify-center gap-2 text-small text-muted">
          <span role="img" aria-label={DOT_LABEL[model.dot]} className={`${dot} ${runDotFill[model.dot]}`} />
          <span>
            <b className="font-semibold text-ink">Run {model.attempt}</b> {rest}
          </span>
        </div>
        <button
          type="button"
          className={`${btnGhost} w-full justify-center`}
          onClick={() => onGoToCurrent(model.currentRunId)}
        >
          Go to current run
        </button>
      </div>
    );
  }

  // kind === 'live'
  const current = runs.find((r) => r.id === currentRunId(runs));
  const runCost = formatCost(current?.cost ?? null);
  const taskCost = formatCost(task.cost);
  const gtot =
    model.isReviewGate && current
      ? [
          `run ${current.attempt}${runCost ? ` ${runCost}` : ''}`,
          taskCost ? `task total ${taskCost}` : null,
          `${runs.length} run${runs.length === 1 ? '' : 's'}`,
        ]
          .filter(Boolean)
          .join(' · ')
      : null;

  return (
    <div className={WRAP}>
      <TaskActions
        task={task}
        variant="footer"
        verificationAttempts={verificationAttempts}
        onEdit={onEdit}
        onChanged={onChanged}
      />
      {gtot && <div className="text-center text-[11.5px] text-faint">{gtot}</div>}
    </div>
  );
}
