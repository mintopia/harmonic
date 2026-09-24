import { useState } from 'react';
import { api } from '../api';
import type { Task } from '../types';
import { escalationActions, taskActions, type TaskAction } from '../task-actions-model';
import { btnAccept, btnGhost, btnQuiet, btnQuietDestructive, btnReject } from '../ui';
import { toastError, toastSuccess } from '../toast';
import { RejectDialog } from './RejectDialog';
import { ResumeDialog } from './ResumeDialog';
import { ExtendGuardrailDialog } from './ExtendGuardrailDialog';
import { DeleteTaskDialog } from './DeleteTaskDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { taskLabel } from '../id-format.js';

type Confirming = 'cancel' | 'complete' | 'close';

export function TaskActions({
  task,
  variant,
  onEdit,
  onChanged,
}: {
  task: Task;
  variant: 'card' | 'footer';
  onEdit: (task: Task) => void;
  onChanged: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  // Accept merges synchronously in the request; without an immediate pending
  // state the click looks inert until it resolves.
  const [accepting, setAccepting] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [extendOpen, setExtendOpen] = useState(false);

  const actions = taskActions(task.state, task.wallClockDeadline);
  const escalation = escalationActions(task);
  // An Accept in flight (merging) is persisted on the Task, not just in this
  // component's `accepting` flag — so the actions stay disabled across a reload
  // or a leave-and-return, never handing the operator a second Accept/Reject
  // that would race it. `resolving-conflicts` is excluded: that merge stalled on
  // a conflict and the operator may want to bail (Close).
  const acceptInFlight = task.mergeStatus === 'merging';
  if (variant === 'footer' && actions.length === 0) return null;

  const secondary = variant === 'card' ? btnQuiet : btnGhost;
  const act = (fn: () => Promise<unknown>) => () => fn().then(onChanged, toastError);
  const actDone = (fn: () => Promise<unknown>, done: string) => () =>
    fn().then(() => {
      toastSuccess(done);
      onChanged();
    }, toastError);

  const onAccept = () => {
    setAccepting(true);
    api.acceptTask(task.id).then(() => {
      toastSuccess(`${taskLabel(task.id)} accepted — merging`, { sticky: true });
      onChanged();
    }, toastError).finally(() => setAccepting(false));
  };
  const onComplete = act(() => api.completeTask(task.id));
  const onPause = () => {
    setPausing(true);
    api.pauseTask(task.id).then(() => {
      toastSuccess(`${taskLabel(task.id)} paused`);
      onChanged();
    }, toastError).finally(() => setPausing(false));
  };
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
          <button key={action} className={btnAccept} onClick={onAccept} disabled={accepting || acceptInFlight}>
            {accepting || acceptInFlight ? 'Accepting…' : label}
          </button>
        );
      }
      case 'reject':
        return (
          <button key={action} className={btnReject} disabled={acceptInFlight} onClick={() => setRejecting(true)}>
            {variant === 'footer' ? 'Reject…' : 'Reject'}
          </button>
        );
      case 'close':
        return (
          <button
            key={action}
            className={btnQuietDestructive}
            disabled={acceptInFlight}
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
      case 'pause':
        return (
          <button key={action} className={secondary} disabled={pausing} onClick={onPause}>
            {pausing ? 'Pausing…' : 'Pause'}
          </button>
        );
      case 'extend':
        return (
          <button key={action} className={secondary} onClick={() => setExtendOpen(true)}>
            Extend time
          </button>
        );
      case 'resume':
        return (
          <button key={action} className={secondary} onClick={() => setResumeOpen(true)}>
            Resume
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
          <button key={action} className={btnQuietDestructive} disabled={acceptInFlight} onClick={() => setDeleting(true)}>
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
      {resumeOpen && (
        <ResumeDialog
          taskId={task.id}
          onClose={() => setResumeOpen(false)}
          onDone={done(() => setResumeOpen(false))}
        />
      )}
      {extendOpen && (
        <ExtendGuardrailDialog
          taskId={task.id}
          onClose={() => setExtendOpen(false)}
          onDone={done(() => setExtendOpen(false))}
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
