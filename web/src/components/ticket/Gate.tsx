import { currentRunId } from '../../run-rail-model';
import type { GateModel } from '../../ticket-gate-model';
import { formatCost } from '../../cost';
import type { Run, Task, VerificationAttempt } from '../../types';
import { btnGhost, dot, runDotFill } from '../../ui';
import { TaskActions } from '../TaskActions';

function formatTokens(run: Run | undefined): string | null {
  const totals = run?.usage?.totals;
  if (!totals) return null;
  const total = totals.totalTokens ?? (totals.inputTokens ?? 0) + (totals.outputTokens ?? 0);
  if (!total) return null;
  return total >= 1000 ? `${Math.round(total / 1000)}k` : `${total}`;
}

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
  if (model.kind === 'none') return null;

  if (model.kind === 'result') {
    const lead = `Run ${model.attempt} `;
    const rest = model.summary.startsWith(lead) ? model.summary.slice(lead.length) : model.summary;
    return (
      <div className="sticky bottom-0 z-10 border-t border-edge bg-surface shadow-bar">
        <div className="mx-auto flex max-w-[1120px] items-center gap-4 px-6 py-3">
          <div className="flex items-center gap-2.5 text-small text-muted">
            <span aria-hidden className={`${dot} ${runDotFill[model.dot]}`} />
            <span>
              <b className="font-semibold text-ink">Run {model.attempt}</b> {rest}
            </span>
          </div>
          <div className="ml-auto flex gap-2.5">
            <button type="button" className={btnGhost} onClick={() => onGoToCurrent(model.currentRunId)}>
              Go to current run
            </button>
          </div>
        </div>
      </div>
    );
  }

  // kind === 'live'
  const current = runs.find((r) => r.id === currentRunId(runs));
  const runCost = formatCost(current?.cost ?? null);
  const tok = formatTokens(current);
  const taskCost = formatCost(task.cost);

  return (
    <div className="sticky bottom-0 z-10 border-t border-edge bg-surface shadow-bar">
      <div className="mx-auto flex max-w-[1120px] items-center gap-4 px-6 py-3">
        {model.isReviewGate && current && (runCost || taskCost) && (
          <div className="shrink-0 text-small text-muted">
            {runCost && (
              <div>
                <span className="text-faint">run {current.attempt}</span>{' '}
                <b className="font-semibold text-ink">{runCost}</b>
                {tok && <> · {tok} tok</>}
              </div>
            )}
            {taskCost && (
              <div className="text-small text-faint">
                task total {taskCost} across {runs.length} run{runs.length === 1 ? '' : 's'}
              </div>
            )}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <TaskActions
            task={task}
            variant="footer"
            verificationAttempts={verificationAttempts}
            onEdit={onEdit}
            onChanged={onChanged}
          />
        </div>
      </div>
    </div>
  );
}
