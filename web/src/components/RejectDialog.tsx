import { useRef, useState } from 'react';
import { api } from '../api';
import { Modal } from './Modal';
import { btnGhost, btnQuietDestructive, field, panelTitle, labelType } from '../ui';

/**
 * The review gate's Reject path. Feedback is saved on the run either way; the
 * destination is the operator's choice: send it back to Ready to retry (reject,
 * then spawn a linked re-attempt carrying the feedback), or mark it Failed and
 * stop.
 *
 * There is deliberately no "cancel" here, and none on the gate. A reviewed task
 * has exactly two outcomes — merge it, or fail it with feedback — because
 * "cancelled" and "failed" would be two names for the same terminal fact once
 * the work already exists, and offering both invites the operator to pick
 * between synonyms. Cancel keeps its meaning where a task has produced nothing
 * to judge (draft / blocked / ready) or is still producing it (running).
 *
 * No cobalt here — this dialog speaks in work states (ready / failed), not the
 * interface's voice.
 */
export function RejectDialog({
  taskId,
  onClose,
  onDone,
}: {
  taskId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reject is one-shot: once it succeeds the task is 'failed' and can no longer
  // be reviewed, so if the follow-up re-attempt fails, a retry must skip reject.
  const rejected = useRef(false);

  // Both reject paths reject first (recording the feedback on the run and
  // failing the task); "retry" then spawns a new task linked to this one,
  // carrying the feedback, instead of re-queuing in place.
  const submit = (retry: boolean) => async () => {
    setBusy(true);
    setError(null);
    const fb = feedback.trim() || undefined;
    try {
      if (!rejected.current) {
        await api.rejectTask(taskId, fb);
        rejected.current = true;
      }
      if (retry) await api.reattempt(taskId, fb);
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };


  return (
    <Modal label={`Reject task #${taskId}`} onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${panelTitle} mb-1`}>Reject task #{taskId}</h2>
        <p className="mb-4 text-muted">
          Feedback is saved on the run. Create a re-attempt to spawn a new task linked to this one, with the notes added
          to its prompt — or mark it failed to stop here.
        </p>
        <label className={`${labelType} mb-1 block text-muted`} htmlFor="reject-feedback">
          Feedback (optional)
        </label>
        <textarea
          id="reject-feedback"
          autoFocus
          rows={4}
          className={`${field} mb-4 resize-y`}
          placeholder="What was wrong, and what the retry should do differently…"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        {error && <p className="mb-3 text-fail">{error}</p>}
        {/* Dismissal is Modal's own X, so the footer carries only the two
            outcomes — nothing here competes with them for the eye. */}
        <div className="flex flex-wrap justify-end gap-2">
          {/* Quiet-destructive, not a fail-tint pill: the tint was the retired
              Ledger's vocabulary, and it spent a state colour (Failed rose
              means the *state*) on an action. Quiet also ranks the two outcomes
              honestly — re-attempting keeps the work moving and is the common
              path, so it takes the heavier Ghost; stopping here is the lesser
              one. No cobalt in this dialog, so Ghost is the top of the scale. */}
          <button type="button" onClick={submit(false)} disabled={busy} className={`${btnQuietDestructive} px-3 py-1.5`}>
            Mark failed
          </button>
          <button type="button" onClick={submit(true)} disabled={busy} className={btnGhost}>
            Create re-attempt
          </button>
        </div>
      </div>
    </Modal>
  );
}
