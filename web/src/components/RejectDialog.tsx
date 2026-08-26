import { useState } from 'react';
import { api } from '../api';
import { toastSuccess } from '../toast';
import { Modal } from './Modal';
import { btnQuietDestructive, field, panelTitle, labelType } from '../ui';
import { taskLabel } from '../id-format.js';

/** Record human feedback on the current attempt. The runner starts the next
 * attempt on this same ticket when the cap permits it. */
export function RejectDialog({
  taskId,
  onClose,
  onDone,
  reject = (feedback) => api.rejectTask(taskId, feedback),
}: {
  taskId: number;
  onClose: () => void;
  onDone: () => void;
  /** The rejection call; escalated tickets route through their own recovery path. */
  reject?: (feedback: string | undefined) => Promise<unknown>;
}) {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await reject(feedback.trim() || undefined);
      toastSuccess(`${taskLabel(taskId)} rejected — feedback sent to the next attempt`);
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal label={`Reject ${taskLabel(taskId)}`} onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${panelTitle} mb-1`}>Reject {taskLabel(taskId)}</h2>
        <p className="mb-4 text-muted">
          Feedback is recorded on this attempt. Harmonic uses it when it starts the next attempt on this ticket.
        </p>
        <label className={`${labelType} mb-1 block text-muted`} htmlFor="reject-feedback">
          Feedback (optional)
        </label>
        <textarea
          id="reject-feedback"
          autoFocus
          rows={4}
          className={`${field} mb-4 resize-y`}
          placeholder="What was wrong, and what the next attempt should do differently…"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        {error && <p className="mb-3 text-fail">{error}</p>}
        <div className="flex justify-end">
          <button type="button" onClick={submit} disabled={busy} className={`${btnQuietDestructive} px-3 py-1.5`}>
            Reject
          </button>
        </div>
      </div>
    </Modal>
  );
}
