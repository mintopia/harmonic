import { Fragment, useState } from 'react';
import { api } from '../api';
import type { Task, VerificationAttempt } from '../types';
import { escalationActions, taskActions, type TaskAction } from '../task-actions-model';
import { btnAccept, btnGhost, btnQuiet, btnQuietDestructive, btnReject } from '../ui';
import { toastError, toastSuccess } from '../toast';
import { overallDecision } from '../verification-attempts-model';
import { RejectDialog } from './RejectDialog';
import { DeleteTaskDialog } from './DeleteTaskDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { taskLabel } from '../id-format.js';

type Confirming = 'cancel' | 'complete' | 'accept-flagged' | 'force-accept' | 'close';

export function TaskActions({
  task,
  variant,
  verificationAttempts,
  onEdit,
  onChanged,
}: {
  task: Task;
  variant: 'card' | 'footer';
  verificationAttempts?: VerificationAttempt[];
  onEdit: (task: Task) => void;
  onChanged: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  // Accept runs verification + merge synchronously in the request; without an
  // immediate pending state the click looks inert until it resolves.
  const [accepting, setAccepting] = useState(false);

  const actions = taskActions(task.state);
  const escalation = escalationActions(task);
  // A merge in flight (Accept) is persisted on the Task, not just in this
  // component's `accepting` flag — so the actions stay disabled across a reload
  // or a leave-and-return, never handing the operator a second Accept/Reject
  // that would race the merge.
  const merging = task.mergeStatus === 'merging';
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

  const acceptWith = (opts?: { force?: boolean }, done?: string) => () => {
    setAccepting(true);
    api.acceptTask(task.id, opts).then(() => {
      toastSuccess(done!, { sticky: true });
      onChanged();
    }, toastError).finally(() => setAccepting(false));
  };
  const onAccept = acceptWith(undefined, `${taskLabel(task.id)} accepted — merging`);
  const onForceAccept = acceptWith({ force: true }, `${taskLabel(task.id)} force-accepted — merging`);
  const onComplete = act(() => api.completeTask(task.id));
  const onCancelTask = actDone(() => api.cancelTask(task.id), `${taskLabel(task.id)} cancelled`);
  const onCloseTask = actDone(() => api.closeTask(task.id), `${taskLabel(task.id)} closed`);

  const confirmThen = (fn: () => void) => () => {
    setConfirming(null);
    fn();
  };

  const button = (action: TaskAction) => {
    switch (action) {
      case 'accept': {
        const label = variant === 'footer' ? 'Accept & merge' : 'Accept';
        if (escalation && !escalation.accept) {
          return (
            <button key={action} className={btnAccept} disabled title="Branch is empty — nothing to merge">
              {label}
            </button>
          );
        }
        return (
          <Fragment key={action}>
            {decision && decision.outcome !== 'proceed' ? (
              <button
                className={btnAccept}
                onClick={() => setConfirming('accept-flagged')}
                disabled={accepting || merging}
              >
                {accepting || merging ? 'Accepting…' : label}
              </button>
            ) : (
              <button className={btnAccept} onClick={onAccept} disabled={accepting || merging}>
                {accepting || merging ? 'Accepting…' : label}
              </button>
            )}
            <button
              className={secondary}
              onClick={() => setConfirming('force-accept')}
              disabled={accepting || merging}
            >
              {accepting || merging ? 'Accepting…' : 'Force accept'}
            </button>
          </Fragment>
        );
      }
      case 'reject':
        return (
          <button key={action} className={btnReject} disabled={merging} onClick={() => setRejecting(true)}>
            {variant === 'footer' ? 'Reject with guidance…' : 'Reject'}
          </button>
        );
      case 'close':
        return (
          <button
            key={action}
            className={btnQuietDestructive}
            disabled={merging}
            onClick={() => setConfirming('close')}
          >
            {variant === 'footer' ? 'Close task' : 'Close'}
          </button>
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
        return (
          <button key={action} className={secondary} onClick={() => setConfirming('complete')}>
            Complete
          </button>
        );
      case 'cancel':
        return (
          <button key={action} className={btnQuietDestructive} onClick={() => setConfirming('cancel')}>
            Cancel
          </button>
        );
      case 'uncancel':
        return (
          <button key={action} className={secondary} onClick={act(() => api.uncancelTask(task.id))}>
            Uncancel
          </button>
        );
      case 'delete':
        return (
          <button key={action} className={btnQuietDestructive} disabled={merging} onClick={() => setDeleting(true)}>
            Delete
          </button>
        );
    }
  };

  const container =
    variant === 'footer'
      ? 'flex flex-col gap-2 [&>button]:w-full [&>button]:justify-center'
      : 'flex flex-wrap items-center justify-end gap-2.5';
  const ordered = (variant === 'footer' ? [...actions].reverse() : actions).filter(
    (action) => !(variant === 'footer' && task.state === 'escalated' && action === 'delete'),
  );
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
      {confirming === 'cancel' && (
        <ConfirmDialog
          label={`Cancel ${taskLabel(task.id)}`}
          title="Cancel this task?"
          confirmLabel="Cancel task"
          tone="danger"
          onCancel={() => setConfirming(null)}
          onConfirm={confirmThen(onCancelTask)}
        >
          This abandons the task. This cannot be undone.
        </ConfirmDialog>
      )}
      {confirming === 'complete' && (
        <ConfirmDialog
          label={`Complete ${taskLabel(task.id)}`}
          title="Mark this task complete?"
          confirmLabel="Complete"
          tone="primary"
          onCancel={() => setConfirming(null)}
          onConfirm={confirmThen(onComplete)}
        >
          Marks the task done without running verification.
        </ConfirmDialog>
      )}
      {confirming === 'accept-flagged' && (
        <ConfirmDialog
          label={`Accept ${taskLabel(task.id)}`}
          title="Critic flagged this attempt"
          confirmLabel="Accept anyway"
          tone="review"
          onCancel={() => setConfirming(null)}
          onConfirm={confirmThen(onAccept)}
        >
          The critic did not recommend merging this candidate. Accept and merge anyway?
        </ConfirmDialog>
      )}
      {confirming === 'force-accept' && (
        <ConfirmDialog
          label={`Force accept ${taskLabel(task.id)}`}
          title="Skip verification and merge?"
          confirmLabel="Skip verification & merge"
          tone="danger"
          onCancel={() => setConfirming(null)}
          onConfirm={confirmThen(onForceAccept)}
        >
          This merges the candidate branch without running verification — implementation, tests, and the critic
          review are all skipped. Use only when you've reviewed the change yourself.
        </ConfirmDialog>
      )}
      {confirming === 'close' && (
        <ConfirmDialog
          label={`Close ${taskLabel(task.id)}`}
          title="Close this task?"
          confirmLabel="Close task"
          tone="danger"
          onCancel={() => setConfirming(null)}
          onConfirm={confirmThen(onCloseTask)}
        >
          This ends the task without merging its candidate. This cannot be undone.
        </ConfirmDialog>
      )}
    </>
  );
}
