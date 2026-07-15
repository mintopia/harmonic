import { useState } from 'react';
import { api } from '../api';
import { Modal } from './Modal';
import { btnGhost, btnQuiet, field, labelType } from '../ui';

/**
 * The review gate's Reject path. Feedback is saved on the run either way;
 * the destination is the operator's choice: send it back to Ready to retry
 * (reject, then requeue — the feedback is appended to the prompt so the next
 * attempt learns from it), or mark it Failed and stop. No indigo here — this
 * dialog speaks in work states (ready / failed), not the interface's voice.
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

  // Both paths reject first (recording the feedback on the run and failing
  // the task); "retry" then requeues the now-failed task back to ready.
  const submit = (retry: boolean) => async () => {
    setBusy(true);
    setError(null);
    const fb = feedback.trim() || undefined;
    try {
      await api.rejectTask(taskId, fb);
      if (retry) await api.requeueTask(taskId, fb);
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal label={`Reject task #${taskId}`} onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className="mb-1 text-headline font-semibold">Reject task #{taskId}</h2>
        <p className="mb-4 text-muted">
          Feedback is saved on the run. Send it back to Ready to retry with the notes added to the prompt, or mark it
          failed to stop here.
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
            Send back to Ready
          </button>
        </div>
      </div>
    </Modal>
  );
}
