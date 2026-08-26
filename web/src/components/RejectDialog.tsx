import { useState } from 'react';
import { api } from '../api';
import { toastSuccess } from '../toast';
import { Modal } from './Modal';
import { btnQuietDestructive, field, panelTitle, labelType } from '../ui';
import { taskLabel } from '../id-format.js';

/** ADR-0041 "Reject with guidance": the guidance becomes the next attempt's
 * feedback, the attempt budget resets, and the loop resumes on the same ticket
 * and branch. Guidance is required — a reject without it teaches nothing. */
export function RejectDialog({
  taskId,
  onClose,
  onDone,
  reject = (guidance) => api.rejectTask(taskId, guidance),
}: {
  taskId: number;
  onClose: () => void;
  onDone: () => void;
  reject?: (guidance: string) => Promise<unknown>;
}) {
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmed = guidance.trim();

  const submit = async () => {
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await reject(trimmed);
      toastSuccess(`${taskLabel(taskId)} rejected — guidance sent to the next attempt`);
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal label={`Reject ${taskLabel(taskId)}`} onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${panelTitle} mb-1`}>Reject {taskLabel(taskId)} with guidance</h2>
        <p className="mb-4 text-muted">
          Your guidance is recorded on the escalated attempt and given to the next one; the attempt budget starts over
          and the loop resumes on the same branch.
        </p>
        <label className={`${labelType} mb-1 block text-muted`} htmlFor="reject-guidance">
          Guidance
        </label>
        <textarea
          id="reject-guidance"
          autoFocus
          rows={4}
          className={`${field} mb-4 resize-y`}
          placeholder="What was wrong, and what the next attempt should do differently…"
          value={guidance}
          onChange={(e) => setGuidance(e.target.value)}
        />
        {error && <p className="mb-3 text-fail">{error}</p>}
        <div className="flex justify-end">
          <button type="button" onClick={submit} disabled={busy || !trimmed} className={`${btnQuietDestructive} px-3 py-1.5`}>
            Reject with guidance
          </button>
        </div>
      </div>
    </Modal>
  );
}
