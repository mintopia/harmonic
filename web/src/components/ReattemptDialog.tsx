import { useState } from 'react';
import { api } from '../api';
import type { Task } from '../types';
import { Modal } from './Modal';
import { btnGhost, field, panelTitle, labelType } from '../ui';
import { taskKey, taskLabel } from '../id-format.js';

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
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={submit} disabled={busy} className={btnGhost}>
            {mirrored ? 'Re-attempt' : 'Create re-attempt'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
