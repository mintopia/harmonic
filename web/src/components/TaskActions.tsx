import { Fragment, useState } from 'react';
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

function AcceptButton({ className, label, onConfirm, busy }: { className: string; label: string; onConfirm: () => void; busy?: boolean }) {
  const { armed, trigger, ref } = useArmedConfirm(onConfirm);
  return (
    <button
      ref={ref}
      disabled={busy}
      className={armed ? 'font-semibold text-fail transition-colors duration-150' : className}
      onClick={trigger}
    >
      {busy ? 'Accepting…' : armed ? 'Critic flagged — accept anyway?' : label}
    </button>
  );
}

function ForceAcceptButton({ className, onConfirm, busy }: { className: string; onConfirm: () => void; busy?: boolean }) {
  const { armed, trigger, ref } = useArmedConfirm(onConfirm);
  return (
    <button
      ref={ref}
      disabled={busy}
      className={armed ? 'font-semibold text-fail transition-colors duration-150' : className}
      onClick={trigger}
    >
      {busy ? 'Accepting…' : armed ? 'Skip verification and merge?' : 'Force accept'}
    </button>
  );
}

function CloseButton({ className, label, onConfirm, disabled }: { className: string; label: string; onConfirm: () => void; disabled?: boolean }) {
  const { armed, trigger, ref } = useArmedConfirm(onConfirm);
  return (
    <button
      ref={ref}
      disabled={disabled}
      className={armed ? 'font-semibold text-fail transition-colors duration-150' : className}
      onClick={trigger}
    >
      {armed ? 'Sure?' : label}
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
  verificationAttempts?: VerificationAttempt[];
  onEdit: (task: Task) => void;
  onChanged: () => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [deleting, setDeleting] = useState(false);
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

  const button = (action: TaskAction) => {
    switch (action) {
      case 'accept': {
        const acceptWith = (opts?: { force?: boolean }, done?: string) => () => {
          setAccepting(true);
          api.acceptTask(task.id, opts).then(() => {
            toastSuccess(done!);
            onChanged();
          }, toastError).finally(() => setAccepting(false));
        };
        const onConfirm = acceptWith(undefined, `${taskLabel(task.id)} accepted — merging`);
        const onForceConfirm = acceptWith({ force: true }, `${taskLabel(task.id)} force-accepted — merging`);
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
              <AcceptButton className={btnAccept} label={label} onConfirm={onConfirm} busy={accepting || merging} />
            ) : (
              <button className={btnAccept} onClick={onConfirm} disabled={accepting || merging}>
                {accepting || merging ? 'Accepting…' : label}
              </button>
            )}
            <ForceAcceptButton className={secondary} onConfirm={onForceConfirm} busy={accepting || merging} />
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
          <CloseButton
            key={action}
            className={btnQuietDestructive}
            label={variant === 'footer' ? 'Close task' : 'Close'}
            disabled={merging}
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
    </>
  );
}
