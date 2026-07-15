import { useState } from 'react';
import { api } from '../api';
import { Modal } from './Modal';
import { btnGhost, btnQuiet, field, headline, labelType } from '../ui';

/**
 * Re-attempt a failed task: create a new task linked to it (copying its
 * setup), carrying optional feedback that is composed into the retry's
 * prompt. The original is left as-is. Same vocabulary as the reject gate's
 * "Create re-attempt".
 */
export function ReattemptDialog({
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

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.reattempt(taskId, feedback.trim() || undefined);
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal label={`Re-attempt task #${taskId}`} onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${headline} mb-1`}>Re-attempt task #{taskId}</h2>
        <p className="mb-4 text-muted">
          Creates a new task linked to #{taskId}, copying its setup. Feedback is added to the retry’s prompt and kept in
          full; the original is left as-is.
        </p>
        <label className={`${labelType} mb-1 block text-muted`} htmlFor="reattempt-feedback">
          Feedback (optional)
        </label>
        <textarea
          id="reattempt-feedback"
          autoFocus
          rows={4}
          className={`${field} mb-4 resize-y`}
          placeholder="What the retry should do differently…"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        {error && <p className="mb-3 text-fail">{error}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={`${btnQuiet} px-3 py-1.5`}>
            Cancel
          </button>
          <button type="button" onClick={create} disabled={busy} className={btnGhost}>
            Create re-attempt
          </button>
        </div>
      </div>
    </Modal>
  );
}
