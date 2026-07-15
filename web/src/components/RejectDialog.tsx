import { useRef, useState } from 'react';
import { api } from '../api';
import { Modal } from './Modal';
import { btnGhost, btnQuiet, field, headline, labelType } from '../ui';

/**
 * The review gate's Reject path. Feedback is saved on the run either way;
 * the destination is the operator's choice: send it back to Ready to retry
 * (reject, then spawn a linked re-attempt carrying the feedback), or mark it
 * Failed and stop. No indigo here — this dialog speaks in work states
 * (ready / failed), not the interface's voice.
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

  // Both paths reject first (recording the feedback on the run and failing
  // the task); "retry" then spawns a new task linked to this one, carrying
  // the feedback, instead of re-queuing in place.
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
        <h2 className={`${headline} mb-1`}>Reject task #{taskId}</h2>
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
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={`${btnQuiet} px-3 py-1.5`}>
            Cancel
          </button>
          <button
            type="button"
            onClick={submit(false)}
            disabled={busy}
            className="rounded-md bg-fail-tint px-3.5 py-2 font-semibold text-fail transition-opacity duration-150 hover:opacity-80 disabled:opacity-50"
          >
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
