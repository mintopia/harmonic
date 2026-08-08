import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Task } from '../types';
import { taskActions, type TaskAction } from '../task-actions-model';
import { btnAccept, btnGhost, btnQuiet, btnQuietDestructive, btnReject } from '../ui';
import { toastError } from '../toast';
import { RejectDialog } from './RejectDialog';
import { ReattemptDialog } from './ReattemptDialog';

/** How long an armed Cancel waits before reverting on its own. */
const ARM_TIMEOUT_MS = 3000;

/**
 * Two-step inline confirm state for a destructive action (DESIGN.md bans
 * native confirm()): the first click arms, the second within ARM_TIMEOUT_MS
 * commits. Clicking anywhere outside the button, or letting the timeout
 * elapse, reverts — so a stray first click never leaves a primed Cancel
 * lying in wait. Mirrors the cancel-with-dependents morph in TaskDetail,
 * but self-reverting.
 */
function useArmedConfirm(onConfirm: () => void) {
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!armed) return;
    const revert = () => setArmed(false);
    const timer = setTimeout(revert, ARM_TIMEOUT_MS);
    // mousedown (not click) so a press that starts outside reverts before it
    // can register as the confirming click elsewhere.
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) revert();
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDown);
    };
  }, [armed]);

  const trigger = () => {
    if (armed) {
      setArmed(false);
      onConfirm();
    } else {
      setArmed(true);
    }
  };

  return { armed, trigger, ref };
}

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
          <CancelButton key={action} className={btnQuietDestructive} onConfirm={act(() => api.cancelTask(task.id))} />
        );
      case 'uncancel':
        return (
          <button key={action} className={secondary} onClick={act(() => api.uncancelTask(task.id))}>
            Uncancel
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
      <div className={container}>
        {/* Un-escalate is a flag action, not a state action (issue #33
            follow-up): hand an escalated mirrored Task back to afk drive.
            Shown only while escalated, beside the state's own actions. */}
        {task.escalated && (
          <button className={secondary} onClick={act(() => api.unescalateTask(task.id))}>
            Un-escalate
          </button>
        )}
        {actions.map(button)}
      </div>
      {rejecting && (
        <RejectDialog taskId={task.id} onClose={() => setRejecting(false)} onDone={done(() => setRejecting(false))} />
      )}
      {reattempting && (
        <ReattemptDialog
          task={task}
          onClose={() => setReattempting(false)}
          onDone={done(() => setReattempting(false))}
        />
      )}
    </>
  );
}
