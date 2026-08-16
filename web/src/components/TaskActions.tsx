import { useState } from 'react';
import { api } from '../api';
import type { Task } from '../types';
import { taskActions, type TaskAction } from '../task-actions-model';
import { btnAccept, btnGhost, btnQuiet, btnQuietDestructive, btnReject, sectionTitle } from '../ui';
import { toastError } from '../toast';
import { RejectDialog } from './RejectDialog';
import { ReattemptDialog } from './ReattemptDialog';
import { useArmedConfirm } from './useArmedConfirm';

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

/** Force-complete a running task, armed with a two-step confirm — it SIGKILLs a
 * working agent and skips the review gate, so no single misclick commits it. */
function CompleteButton({ className, onConfirm }: { className: string; onConfirm: () => void }) {
  const { armed, trigger, ref } = useArmedConfirm(onConfirm);
  return (
    <button
      ref={ref}
      className={armed ? 'font-semibold text-accept transition-colors duration-150' : className}
      onClick={trigger}
    >
      {armed ? 'Sure?' : 'Complete'}
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
      case 'complete':
        return <CompleteButton key={action} className={secondary} onConfirm={act(() => api.completeTask(task.id))} />;
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

  // On awaiting-review, the detail-modal footer IS the review gate (DESIGN
  // § Task detail): it takes its own ground (the Raised inset) and a short
  // label so it reads unmistakably as THE gate rather than a generic action
  // row. The cobalt stays where the design puts the gate's loudness — the
  // accent top-rule (the awaiting-review state's lane colour) and the Accept
  // primary within — so the ground itself doesn't spend the accent budget
  // (the One Cobalt Rule). The gate lives only in the footer; the board card
  // stays a glance (issue #94).
  const isReviewGate = variant === 'footer' && task.state === 'awaiting-review';
  const container = isReviewGate
    ? 'flex flex-wrap items-center gap-2.5 border-t border-accent bg-raised px-4 py-3'
    : variant === 'footer'
      ? 'flex flex-wrap items-center justify-end gap-2.5 border-t border-hairline px-4 py-3'
      : 'flex flex-wrap items-center justify-end gap-2.5';
  const done = (close: () => void) => () => {
    close();
    onChanged();
  };

  return (
    <>
      <div className={container}>
        {isReviewGate && (
          <div className="mr-auto">
            <div className={sectionTitle}>Review gate</div>
            <div className="text-small text-muted">Read the changes, then accept to merge.</div>
          </div>
        )}
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
