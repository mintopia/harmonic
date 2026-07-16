import { useState } from 'react';
import { api } from '../api';
import type { Task } from '../types';
import { taskActions, type TaskAction } from '../task-actions-model';
import { btnAccept, btnGhost, btnQuiet, btnQuietDestructive, btnReject } from '../ui';
import { toastError } from '../toast';
import { RejectDialog } from './RejectDialog';
import { ReattemptDialog } from './ReattemptDialog';

/**
 * The task's operator actions, rendered from the shared taskActions() map
 * so the board card and the detail modal footer never drift. The only
 * per-surface differences are props: secondary actions read as quiet text
 * on the dense card and bordered ghost buttons in the modal footer, and
 * the footer disappears entirely for terminal states.
 */
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
  const [reattempting, setReattempting] = useState(false);

  const actions = taskActions(task.state);
  if (variant === 'footer' && actions.length === 0) return null;

  const secondary = variant === 'card' ? btnQuiet : btnGhost;
  const act = (fn: () => Promise<unknown>) => () => fn().then(onChanged, toastError);

  const button = (action: TaskAction) => {
    switch (action) {
      case 'accept':
        return (
          <button key={action} className={btnAccept} onClick={act(() => api.acceptTask(task.id))}>
            Accept
          </button>
        );
      case 'reject':
        return (
          <button key={action} className={btnReject} onClick={() => setRejecting(true)}>
            Reject
          </button>
        );
      case 'reattempt':
        return (
          <button key={action} className={secondary} onClick={() => setReattempting(true)}>
            Re-attempt
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
      case 'cancel':
        return (
          <button key={action} className={btnQuietDestructive} onClick={act(() => api.cancelTask(task.id))}>
            Cancel
          </button>
        );
    }
  };

  const container =
    variant === 'footer'
      ? 'flex flex-wrap items-center justify-end gap-2.5 border-t border-hairline px-4 py-3'
      : 'flex flex-wrap items-center justify-end gap-2.5';
  const done = (close: () => void) => () => {
    close();
    onChanged();
  };

  return (
    <>
      <div className={container}>{actions.map(button)}</div>
      {rejecting && (
        <RejectDialog taskId={task.id} onClose={() => setRejecting(false)} onDone={done(() => setRejecting(false))} />
      )}
      {reattempting && (
        <ReattemptDialog
          taskId={task.id}
          onClose={() => setReattempting(false)}
          onDone={done(() => setReattempting(false))}
        />
      )}
    </>
  );
}
