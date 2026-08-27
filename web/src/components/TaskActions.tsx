import { useState } from 'react';
import { api } from '../api';
import type { Task, VerificationAttempt } from '../types';
import { escalationActions, taskActions, type TaskAction } from '../task-actions-model';
import { btnAccept, btnGhost, btnQuiet, btnQuietDestructive, btnReject } from '../ui';
import { toastError, toastSuccess } from '../toast';
import { overallDecision } from '../verification-attempts-model';
import { RejectDialog } from './RejectDialog';
import { DeleteTaskDialog } from './DeleteTaskDialog';
import { useArmedConfirm } from './useArmedConfirm';
import { taskLabel } from '../id-format.js';

/** Cancel, armed with a two-step confirm. Its own component so the hook is
 * called unconditionally (rules of hooks), not inside the action switch. */
function CancelButton({ className, onConfirm }: { className: string; onConfirm: () => void }) {
  const { armed, trigger, ref } = useArmedConfirm(onConfirm);
  return (
    <button
      ref={ref}
      className={armed ? 'font-semibold text-fail transition-colors duration-150' : className}
      onClick={trigger}
    >
      {armed ? 'Sure?' : 'Cancel'}
    </button>
  );
}

/** Force-complete a working task, armed with a two-step confirm — it SIGKILLs a
 * working agent and skips verification, so no single misclick commits it. */
function CompleteButton({ className, onConfirm }: { className: string; onConfirm: () => void }) {
  const { armed, trigger, ref } = useArmedConfirm(onConfirm);
  return (
    <button
      ref={ref}
      className={armed ? 'font-semibold text-ink transition-colors duration-150' : className}
      onClick={trigger}
    >
      {armed ? 'Sure?' : 'Complete'}
    </button>
  );
}

/** Accept, armed with a two-step confirm when the run's Verification verdict
 * is block/escalate (issue #174 FIX 1). The critic's verdict lives in an
 * un-flagged Details tab, so a red verdict was invisible here and Accept could
 * merge it blind; arming forces a second, verdict-naming click before it does,
 * mirroring CancelButton/CompleteButton's own gate above. */
function AcceptButton({ className, label, onConfirm }: { className: string; label: string; onConfirm: () => void }) {
  const { armed, trigger, ref } = useArmedConfirm(onConfirm);
  return (
    <button
      ref={ref}
      className={armed ? 'font-semibold text-fail transition-colors duration-150' : className}
      onClick={trigger}
    >
      {armed ? 'Critic flagged — accept anyway?' : label}
    </button>
  );
}

/** Close an escalated ticket (cancel + branch/worktree/tracker cleanup), armed like Cancel. */
function CloseButton({ className, onConfirm }: { className: string; onConfirm: () => void }) {
  const { armed, trigger, ref } = useArmedConfirm(onConfirm);
  return (
    <button
      ref={ref}
      className={armed ? 'font-semibold text-fail transition-colors duration-150' : className}
      onClick={trigger}
    >
      {armed ? 'Sure?' : 'Close'}
    </button>
  );
}

export function TaskActions({
  task,
  variant,
  verificationAttempts,
  onEdit,
  onChanged,
}: {
  task: Task;
  variant: 'card' | 'footer';
  // Optional (issue #174 FIX 1): only the detail modal's footer has the
  // selected run's Verification log in scope; card callers pass nothing and
  // Accept stays the plain immediate button it always was.
  verificationAttempts?: VerificationAttempt[];
  onEdit: (task: Task) => void;
  onChanged: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const actions = taskActions(task.state);
  const escalation = escalationActions(task);
  if (variant === 'footer' && actions.length === 0) return null;

  const decision =
    verificationAttempts && verificationAttempts.length > 0 ? overallDecision(verificationAttempts) : null;

  const secondary = variant === 'card' ? btnQuiet : btnGhost;
  const act = (fn: () => Promise<unknown>) => () => fn().then(onChanged, toastError);
  const actDone = (fn: () => Promise<unknown>, done: string) => () =>
    fn().then(() => {
      toastSuccess(done);
      onChanged();
    }, toastError);

  const button = (action: TaskAction) => {
    switch (action) {
      case 'accept': {
        const onConfirm = actDone(() => api.acceptTask(task.id), `${taskLabel(task.id)} accepted — merging`);
        const label = variant === 'footer' ? 'Accept & merge' : 'Accept';
        if (escalation && !escalation.accept) {
          return (
            <button key={action} className={btnAccept} disabled title="No verified branch head to merge">
              {label}
            </button>
          );
        }
        return decision && decision.outcome !== 'proceed' ? (
          <AcceptButton key={action} className={btnAccept} label={label} onConfirm={onConfirm} />
        ) : (
          <button key={action} className={btnAccept} onClick={onConfirm}>
            {label}
          </button>
        );
      }
      case 'reject':
        return (
          <button key={action} className={btnReject} onClick={() => setRejecting(true)}>
            {variant === 'footer' ? 'Reject with guidance…' : 'Reject'}
          </button>
        );
      case 'close':
        return (
          <CloseButton
            key={action}
            className={btnQuietDestructive}
            onConfirm={actDone(() => api.closeTask(task.id), `${taskLabel(task.id)} closed`)}
          />
        );
      case 'run':
        return (
          <button key={action} className={secondary} onClick={act(() => api.runTask(task.id))}>
            Run now
          </button>
        );
      case 'ready':
        return (
          <button key={action} className={secondary} onClick={act(() => api.promoteTask(task.id))}>
            Ready
          </button>
        );
      case 'edit':
        return (
          <button key={action} className={btnQuiet} onClick={() => onEdit(task)}>
            Edit
          </button>
        );
      case 'complete':
        return <CompleteButton key={action} className={secondary} onConfirm={act(() => api.completeTask(task.id))} />;
      case 'cancel':
        return (
          <CancelButton
            key={action}
            className={btnQuietDestructive}
            onConfirm={actDone(() => api.cancelTask(task.id), `${taskLabel(task.id)} cancelled`)}
          />
        );
      case 'uncancel':
        return (
          <button key={action} className={secondary} onClick={act(() => api.uncancelTask(task.id))}>
            Uncancel
          </button>
        );
      case 'delete':
        return (
          <button key={action} className={btnQuietDestructive} onClick={() => setDeleting(true)}>
            Delete
          </button>
        );
    }
  };

  // Footer (ticket rail) stacks the verbs vertically and full-width to match
  // the Paper mockup — Accept on top, the quiet Delete escape hatch last.
  // `card` keeps the original inline row.
  const container =
    variant === 'footer'
      ? 'flex flex-col gap-2 [&>button]:w-full [&>button]:justify-center'
      : 'flex flex-wrap items-center justify-end gap-2.5';
  const ordered = variant === 'footer' ? [...actions].reverse() : actions;
  const done = (close: () => void) => () => {
    close();
    onChanged();
  };

  return (
    <>
      <div className={container}>{ordered.map(button)}</div>
      {rejecting && (
        <RejectDialog
          taskId={task.id}
          onClose={() => setRejecting(false)}
          onDone={done(() => setRejecting(false))}
        />
      )}
      {deleting && (
        <DeleteTaskDialog task={task} onClose={() => setDeleting(false)} onDone={done(() => setDeleting(false))} />
      )}
    </>
  );
}
