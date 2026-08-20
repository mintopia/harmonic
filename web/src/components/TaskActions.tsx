import { useState } from 'react';
import { api } from '../api';
import type { Task, VerificationAttempt } from '../types';
import { taskActions, showsEscalationRecovery, type TaskAction } from '../task-actions-model';
import { btnAccept, btnGhost, btnQuiet, btnQuietDestructive, btnReject, sectionTitle } from '../ui';
import { toastError, toastSuccess } from '../toast';
import { overallDecision } from '../verification-attempts-model';
import type { VerificationOutcome } from '../verification-model';
import { RejectDialog } from './RejectDialog';
import { ReattemptDialog } from './ReattemptDialog';
import { NoteToCriticDialog } from './NoteToCriticDialog';
import { DeleteTaskDialog } from './DeleteTaskDialog';
import { useArmedConfirm } from './useArmedConfirm';
import { taskLabel } from '../id-format.js';

/** Review-gate verdict summary tone (issue #174 FIX 1) — text-only, unlike
 * VerificationCard's OUTCOME_TONE chips, since this lives in a one-line
 * footer strip rather than a tinted pill. `proceed` reads as muted (nothing
 * to flag); `block`/`escalate` both read fail-red — the footer's job is only
 * to say "go read Details", not to distinguish the two here. */
const DECISION_TONE: Record<VerificationOutcome, string> = {
  proceed: 'text-muted',
  block: 'text-fail',
  escalate: 'text-fail',
};

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

/** Accept, armed with a two-step confirm when the run's Verification verdict
 * is block/escalate (issue #174 FIX 1). The critic's verdict lives in an
 * un-flagged Details tab, so a red verdict was invisible at this gate and
 * Accept could merge it blind; arming forces a second, verdict-naming click
 * before it does, mirroring CancelButton/CompleteButton's own gate above. */
function AcceptButton({ className, onConfirm }: { className: string; onConfirm: () => void }) {
  const { armed, trigger, ref } = useArmedConfirm(onConfirm);
  return (
    <button
      ref={ref}
      className={armed ? 'font-semibold text-fail transition-colors duration-150' : className}
      onClick={trigger}
    >
      {armed ? 'Critic flagged — accept anyway?' : 'Accept'}
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
  const [reattempting, setReattempting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notingToCritic, setNotingToCritic] = useState(false);

  const actions = taskActions(task.state);
  if (variant === 'footer' && actions.length === 0) return null;

  // The run's current Verification decision, if any attempts have landed —
  // drives both the review-gate's inline verdict line and whether Accept
  // arms itself (issue #174 FIX 1).
  const decision =
    verificationAttempts && verificationAttempts.length > 0 ? overallDecision(verificationAttempts) : null;

  const secondary = variant === 'card' ? btnQuiet : btnGhost;
  const act = (fn: () => Promise<unknown>) => () => fn().then(onChanged, toastError);
  // A gate action (accept/cancel) that acknowledges itself on success — a
  // confirmation toast naming what happened, so an irreversible click never
  // lands silently (issue #98). Reject is acknowledged in RejectDialog.
  const actDone = (fn: () => Promise<unknown>, done: string) => () =>
    fn().then(() => {
      toastSuccess(done);
      onChanged();
    }, toastError);

  const button = (action: TaskAction) => {
    switch (action) {
      case 'accept': {
        const onConfirm = actDone(() => api.acceptTask(task.id), `${taskLabel(task.id)} accepted — merging`);
        // Gate-arm rationale (issue #174 FIX 1): a block/escalate verdict is
        // otherwise invisible at this footer, so Accept alone could merge it
        // blind. Arming only when the verdict is red keeps the common case
        // (proceed, or no Verification configured) the same single click it
        // always was.
        return decision && decision.outcome !== 'proceed' ? (
          <AcceptButton key={action} className={btnAccept} onConfirm={onConfirm} />
        ) : (
          <button key={action} className={btnAccept} onClick={onConfirm}>
            Accept
          </button>
        );
      }
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
      // Distinct from Cancel (issue #162): permanent, confirmed in its own
      // dialog rather than CancelButton's inline two-click arm, and quiet
      // here so it never visually competes with Cancel's own destructive slot.
      case 'delete':
        return (
          <button key={action} className={btnQuietDestructive} onClick={() => setDeleting(true)}>
            Delete
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
            {/* Inline verdict summary (issue #174 FIX 1): the critic's
                verdict otherwise sits unflagged in the Details tab, so put
                the one-line proceed/block/escalate readout where Accept is
                clicked. Truncated to stay one line beside the gate text. */}
            {decision && (
              <div className={`mt-0.5 max-w-sm truncate text-small ${DECISION_TONE[decision.outcome]}`}>
                <span className="font-semibold">{decision.outcome}</span> — {decision.reason}
              </div>
            )}
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
        {/* Escalated-candidate recovery (issue #191): flag actions beside
            Un-escalate, not part of taskActions(state) — an afk→hitl
            escalation drops back to `ready` with the last run's candidate
            stranded on a private ref. Adopt & review is the primary
            affirmative path (the accent stays sanctioned here as a second
            primary alongside the gate's own Accept, same as issue #174's
            accept-anyway); Note to critic is a plain secondary ghost button
            (One Cobalt Rule) that re-runs only the critic, not the builder. */}
        {showsEscalationRecovery(task) && (
          <>
            <button className={secondary} onClick={() => setNotingToCritic(true)}>
              Note to critic
            </button>
            <button
              className={btnAccept}
              onClick={actDone(() => api.adoptReview(task.id), `${taskLabel(task.id)} adopted — awaiting review`)}
            >
              Adopt &amp; review
            </button>
          </>
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
      {deleting && (
        <DeleteTaskDialog task={task} onClose={() => setDeleting(false)} onDone={done(() => setDeleting(false))} />
      )}
      {notingToCritic && (
        <NoteToCriticDialog
          task={task}
          onClose={() => setNotingToCritic(false)}
          onDone={done(() => setNotingToCritic(false))}
        />
      )}
    </>
  );
}
