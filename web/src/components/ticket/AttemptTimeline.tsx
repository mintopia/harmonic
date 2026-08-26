import { useState } from 'react';
import { api } from '../../api.js';
import {
  attemptTone,
  continuationDetail,
  continuationLabel,
  elapsed,
  runForAttempt,
  stateTone,
  taskLabel,
  type TimelineTone,
} from '../../attempt-timeline-model.js';
import type { Attempt, AttemptTask, Run, Task } from '../../types.js';
import { escalationActions } from '../../task-actions-model.js';
import { btnAccept, btnGhost, btnQuietDestructive, railSectionCount, railSectionHead } from '../../ui.js';
import { toastError, toastSuccess } from '../../toast.js';
import { taskLabel as ticketLabel } from '../../id-format.js';
import { Icon } from '../Icon.js';
import { RejectDialog } from '../RejectDialog.js';
import { useArmedConfirm } from '../useArmedConfirm.js';

const DOT: Record<TimelineTone, string> = {
  running: 'bg-running-dot motion-safe:animate-dot-pulse',
  passed: 'bg-merged-dot',
  failed: 'bg-fail-dot',
  neutral: 'bg-edge',
};
const WORD: Record<TimelineTone, string> = {
  running: 'text-running',
  passed: 'text-merged',
  failed: 'text-fail',
  neutral: 'text-muted',
};

const SELECTED = 'border-await bg-await-tint';
const IDLE = 'border-transparent hover:bg-raised';

function CloseButton({ onConfirm }: { onConfirm: () => void }) {
  const { armed, trigger, ref } = useArmedConfirm(onConfirm);
  return (
    <button ref={ref} type="button" onClick={trigger} className={armed ? 'font-semibold text-fail' : btnQuietDestructive}>
      {armed ? 'Sure?' : 'Close'}
    </button>
  );
}

/** ADR-0041's one escalation surface: the trigger and exactly three actions,
 * on the attempt that escalated. Accept lands the verified branch head as-is,
 * Reject with guidance resumes the loop, Close cancels the ticket and cleans up. */
function Escalation({ attempt, task, onChanged, compact = false }: { attempt: Attempt; task: Task; onChanged: () => void; compact?: boolean }) {
  const [rejecting, setRejecting] = useState(false);
  const actions = escalationActions(task);
  const reason = (attempt.escalationReason ?? task.escalationReason)?.replace(/^escalated to human:\s*/i, '') ?? null;
  const accept = () =>
    api.acceptTask(task.id).then(() => {
      toastSuccess(`${ticketLabel(task.id)} accepted — merging`);
      onChanged();
    }, toastError);
  const close = () =>
    api.closeTask(task.id).then(() => {
      toastSuccess(`${ticketLabel(task.id)} closed`);
      onChanged();
    }, toastError);
  return (
    <div className="mt-2 rounded-sm bg-await-tint px-2.5 py-2 text-small">
      <div className="flex items-center gap-1.5 font-semibold text-await">
        <Icon name="alert-triangle" className="size-3.5" />
        Escalated
      </div>
      {reason && <p className="mt-1 whitespace-pre-wrap break-words text-ink">{reason}</p>}
      {actions && (
        <div className={compact ? 'mt-2 flex flex-wrap items-center gap-2' : 'mt-2.5 flex flex-col gap-1.5 [&>button]:w-full [&>button]:justify-center'}>
          <button type="button" className={btnAccept} disabled={!actions.accept} title={actions.accept ? undefined : 'No verified branch head to land'} onClick={accept}>
            Accept
          </button>
          <button type="button" className={btnGhost} onClick={() => setRejecting(true)}>
            Reject with guidance…
          </button>
          <CloseButton onConfirm={close} />
        </div>
      )}
      {rejecting && (
        <RejectDialog
          taskId={task.id}
          onClose={() => setRejecting(false)}
          onDone={() => {
            setRejecting(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function TaskRow({ task, now, selected, onSelect }: { task: AttemptTask; now: number; selected: boolean; onSelect: () => void }) {
  const tone = stateTone(task.state);
  return (
    <li>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={`flex min-h-11 w-full items-center gap-2 rounded-sm border px-2 py-1.5 text-left text-small transition-colors ${selected ? SELECTED : IDLE}`}
      >
        <span role="img" aria-label={task.state} className={`size-1.5 shrink-0 rounded-full ${DOT[tone]}`} />
        <span className="min-w-0 flex-1 truncate text-ink">{taskLabel(task)}</span>
        <span className={`shrink-0 text-label font-bold uppercase tracking-[0.03em] ${WORD[tone]}`}>{task.verdict ?? task.state}</span>
        <span className="w-12 shrink-0 text-right text-[11.5px] tabular-nums text-faint">{elapsed(task.startedAt, task.endedAt, now)}</span>
      </button>
    </li>
  );
}

// Attempt switching drives the whole pane, so it must stay reachable. Vertical
// in the wide rail; a sticky horizontal strip at narrow widths where the rail
// stacks below the fold (layout="strip").
export function AttemptTimeline({
  attempts,
  runs,
  task,
  maxAttempts,
  now,
  selectedRunId,
  selectedAttemptId,
  selectedTaskId,
  selectedFile,
  onSelectAttempt,
  onSelectTask,
  onChanged,
  layout = 'rail',
}: {
  attempts: Attempt[];
  runs: Run[];
  task: Task;
  maxAttempts: number | null;
  now: number;
  selectedRunId: number | null;
  /** Explicit attempt pick; null falls back to the selected Run's latest attempt. */
  selectedAttemptId: number | null;
  selectedTaskId: number | null;
  selectedFile: string | null;
  onSelectAttempt: (attempt: Attempt) => void;
  onSelectTask: (attempt: Attempt, task: AttemptTask) => void;
  onChanged: () => void;
  layout?: 'rail' | 'strip';
}) {
  const strip = layout === 'strip';
  const currentAttemptId =
    selectedAttemptId ?? [...attempts].reverse().find((attempt) => runForAttempt(runs, attempt)?.id === selectedRunId)?.id ?? null;
  const isAttemptSelected = (attempt: Attempt) =>
    selectedFile === null && attempt.id === currentAttemptId && !attempt.tasks.some((row) => row.id === selectedTaskId);
  // The escalation surface rides the attempt that escalated; an escalation with
  // no attempt of its own (e.g. a missing integration branch) rides the latest.
  const escalated = task.state === 'escalated' ? [...attempts].reverse().find((attempt) => attempt.state === 'escalated') ?? attempts.at(-1) ?? null : null;

  return (
    <section className={strip ? '' : 'border-b border-hairline px-3.5 py-3.5'} aria-label="Attempt history">
      <div className={railSectionHead}>
        Attempts <span className={railSectionCount}>{attempts.length}{maxAttempts !== null && ` / ${maxAttempts}`}</span>
      </div>
      {attempts.length === 0 ? (
        <p className="text-small text-muted">This ticket hasn't been attempted yet.</p>
      ) : (
        <ol className={strip ? 'flex gap-1.5 overflow-x-auto pb-0.5' : 'flex flex-col gap-2.5'}>
          {attempts.map((attempt) => {
            const tone = attemptTone(attempt.state);
            const selected = isAttemptSelected(attempt);
            const header = (
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelectAttempt(attempt)}
                className={`flex min-h-11 items-center gap-2.5 rounded-sm border px-2.5 py-2 text-left transition-colors ${strip ? 'shrink-0' : 'w-full'} ${selected ? SELECTED : IDLE}`}
              >
                <span role="img" aria-label={attempt.state} className={`size-2 shrink-0 rounded-full ${DOT[tone]}`} />
                <span className="text-data font-semibold text-ink">Attempt {attempt.number}</span>
                <span className={`ml-auto text-label font-bold uppercase tracking-[0.03em] ${WORD[tone]}`}>{attempt.state}</span>
                {!strip && <span className="text-[11.5px] tabular-nums text-faint">{elapsed(attempt.startedAt, attempt.endedAt, now)}</span>}
              </button>
            );
            if (strip) return <li key={attempt.id} className="shrink-0">{header}</li>;
            const continuation = continuationLabel(attempt.continuation);
            return (
              <li key={attempt.id}>
                {header}
                {continuation && (
                  <div className="mt-1 flex flex-wrap items-center gap-x-1.5 pl-2.5 text-[11.5px] text-faint">
                    <Icon name="refresh" className="size-3" />
                    <span className="text-muted">{continuation}</span>
                    <span>{continuationDetail(attempt.continuation)}</span>
                  </div>
                )}
                <ol className="ml-[13px] mt-1 flex flex-col gap-0.5 border-l border-hairline pl-2">
                  {attempt.tasks.map((row) => (
                    <TaskRow key={row.id} task={row} now={now} selected={selectedFile === null && row.id === selectedTaskId} onSelect={() => onSelectTask(attempt, row)} />
                  ))}
                </ol>
                {attempt.feedback && (
                  <div className="ml-[13px] mt-1.5 border-l border-hairline pl-4 text-small text-muted">
                    <span className="text-label font-bold uppercase tracking-[0.06em] text-faint">Feedback → next attempt</span>
                    <p className="mt-0.5 line-clamp-4 whitespace-pre-wrap break-words" title={attempt.feedback}>{attempt.feedback}</p>
                  </div>
                )}
                {attempt.id === escalated?.id && <Escalation attempt={attempt} task={task} onChanged={onChanged} />}
              </li>
            );
          })}
        </ol>
      )}
      {strip && escalated && <Escalation attempt={escalated} task={task} onChanged={onChanged} compact />}
    </section>
  );
}
