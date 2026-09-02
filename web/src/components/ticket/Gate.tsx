import type { AttemptDot } from '../../attempt-rail-model';
import type { GateModel } from '../../ticket-gate-model';
import type { Task, VerificationAttempt } from '../../types';
import { btnGhost, dot, runDotFill } from '../../ui';
import { taskActions } from '../../task-actions-model';
import { TaskActions } from '../TaskActions';

const DOT_LABEL: Record<AttemptDot, string> = {
  running: 'running',
  fail: 'failed',
  merged: 'merged',
  neutral: 'neutral',
};

const WRAP = 'sticky bottom-0 z-[5] flex flex-col gap-2.5 border-t border-hairline bg-surface px-3.5 pt-3.5 pb-12 shadow-float';

export function Gate({
  model,
  task,
  verificationAttempts,
  onEdit,
  onChanged,
  onGoToCurrent,
}: {
  model: GateModel;
  task: Task;
  verificationAttempts: VerificationAttempt[];
  onEdit: (task: Task) => void;
  onChanged: () => void;
  onGoToCurrent: (attemptId: number) => void;
}) {
  if (model.kind === 'none') {
    if (taskActions(task.state).length === 0) return null;
    return (
      <div className={WRAP}>
        <TaskActions task={task} variant="footer" verificationAttempts={verificationAttempts} onEdit={onEdit} onChanged={onChanged} />
      </div>
    );
  }

  if (model.kind === 'result') {
    const lead = `Attempt ${model.number} `;
    const rest = model.summary.startsWith(lead) ? model.summary.slice(lead.length) : model.summary;
    return (
      <div className={WRAP}>
        <div className="flex items-center justify-center gap-2 text-small text-muted">
          <span role="img" aria-label={DOT_LABEL[model.dot]} className={`${dot} ${runDotFill[model.dot]}`} />
          <span>
            <b className="font-semibold text-ink">Attempt {model.number}</b> {rest}
          </span>
        </div>
        <button
          type="button"
          className={`${btnGhost} w-full justify-center`}
          onClick={() => onGoToCurrent(model.currentAttemptId)}
        >
          Go to current attempt
        </button>
      </div>
    );
  }

  return (
    <div className={WRAP}>
      <TaskActions
        task={task}
        variant="footer"
        verificationAttempts={verificationAttempts}
        onEdit={onEdit}
        onChanged={onChanged}
      />
    </div>
  );
}
