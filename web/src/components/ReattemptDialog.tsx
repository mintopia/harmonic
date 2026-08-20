import { useState } from 'react';
import { api } from '../api';
import type { Task } from '../types';
import { Modal } from './Modal';
import { btnGhost, field, panelTitle, labelType } from '../ui';
import { taskKey, taskLabel } from '../id-format.js';

/**
 * Give a failed task feedback and send it back for another attempt.
 *
 * - **native**: creates a new task linked to the original (copying its setup),
 *   carrying the feedback composed into the retry's prompt; the original is
 *   left as-is. Same vocabulary as the reject gate's "Create re-attempt".
 * - **mirrored**: re-queues the same task in place (failed → ready) so it stays
 *   linked to its tracker issue. Cloning it would strand the mirror, and the
 *   feedback rides the `feedback` column — the one field a re-poll doesn't
 *   overwrite (the prompt is re-derived from the ticket).
 */
export function ReattemptDialog({
  task,
  onClose,
  onDone,
}: {
  task: Task;
  onClose: () => void;
  onDone: () => void;
}) {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mirrored = task.origin === 'mirrored';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const fb = feedback.trim() || undefined;
      if (mirrored) await api.requeueTask(task.id, fb);
      else await api.reattempt(task.id, fb);
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal label={`Re-attempt ${taskLabel(task.id)}`} onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${panelTitle} mb-1`}>Re-attempt {taskLabel(task.id)}</h2>
        <p className="mb-4 text-muted">
          {mirrored
            ? `Re-runs ${taskKey(task.id)} in place, keeping it linked to its tracker issue. Your feedback is carried into the next attempt.`
            : `Creates a new task linked to ${taskKey(task.id)}, copying its setup. Feedback is added to the retry’s prompt and kept in full; the original is left as-is.`}
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
        {/* Dismissal is Modal's X. The button that used to sit here read
            "Cancel" and meant "dismiss" — the same word the board uses for
            abandoning a task, a few pixels from an action that creates one. */}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={submit} disabled={busy} className={btnGhost}>
            {mirrored ? 'Re-attempt' : 'Create re-attempt'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
