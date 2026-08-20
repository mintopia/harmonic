import { currentRunId } from '../../run-rail-model';
import type { GateModel } from '../../ticket-gate-model';
import { formatCost } from '../../cost';
import type { Run, Task, VerificationAttempt } from '../../types';
import { btnGhost, dot, runDotFill } from '../../ui';
import { TaskActions } from '../TaskActions';

/** A Run's token count off its `usage.totals`, compact ("63k") like the
 * prototype's cost cluster. `usage.totals` is a loosely-typed
 * `Record<string, number | null>` on the wire (mirrors `RunMeta`'s own `as
 * any` read of the same field) — this reads the same `inputTokens`/
 * `outputTokens`/`totalTokens` keys. Null when there's nothing to show. */
function formatTokens(run: Run | undefined): string | null {
  const totals = run?.usage?.totals as
    | { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null }
    | null
    | undefined;
  if (!totals) return null;
  const total = totals.totalTokens ?? (totals.inputTokens ?? 0) + (totals.outputTokens ?? 0);
  if (!total) return null;
  return total >= 1000 ? `${Math.round(total / 1000)}k` : `${total}`;
}

/**
 * The Ticket page's bottom bar (issue #183, part of #179): sticky, driven by
 * the locked `gateForRun` decision. `none` renders nothing; `result` is a
 * read-only summary of a historical Run with a "Go to current run" escape;
 * `live` embeds `TaskActions` verbatim (it owns the gate button logic —
 * accept/reject, the accept-anyway arming, and the review-gate styling) and,
 * only on the real review gate, adds the prototype's cost cluster.
 *
 * `runs` isn't in the model's own props list the ticket sketched, but the
 * cost cluster needs the *current* Run's cost/usage and the task total's run
 * count — data the `GateModel` deliberately doesn't carry (it's a decision,
 * not a data bag) — so this reads it straight off `runs` via the same locked
 * `currentRunId` the model itself uses, rather than re-deriving "current".
 */
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
    // The locked model's `summary` already reads "Run N <word> · superseded
    // by Run M" — only the "Run N" lead is bold here (prototype `.hist b`),
    // so the sentence itself stays the model's, not re-derived.
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
                {/* A token *count* is a figure, not a code identity — sans with
                    tabular-nums (the body default), not the mono code face
                    (DESIGN.md § Mono Is Code Rule). */}
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
        {/* TaskActions owns its own container (border/background/padding) —
            the gate's own accent-top review styling lives there, not here.
            `min-w-0 flex-1` lets it keep its internal `mr-auto` label/actions
            split at the full remaining row width. */}
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
