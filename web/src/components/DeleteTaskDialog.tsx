import { useState } from 'react';
import { api } from '../api';
import type { Task } from '../types';
import { toastSuccess } from '../toast';
import { Modal } from './Modal';
import { btnDestructive, panelTitle } from '../ui';

/**
 * The hard-delete confirm (issue #162, ADR-0025). Deliberately its own dialog
 * rather than CancelButton's two-click arm (TaskActions.tsx): delete is
 * permanent — it cascades the Task's Runs/history server-side — where Cancel
 * just parks the Task in a `cancelled` state it can leave again (Uncancel).
 * A one-line arm risks reading as "just a stronger Cancel"; a named dialog
 * makes the distinction, and what's about to be lost, explicit.
 *
 * Server-guarded to a non-running Task (409 otherwise) — the same shape as
 * `taskActions` already withholding the action while running, so this dialog
 * never has to render that refusal.
 */
export function DeleteTaskDialog({
  task,
  onClose,
  onDone,
}: {
  task: Task;
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mirrored = task.origin === 'mirrored';

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteTask(task.id);
      toastSuccess(`Task #${task.id} deleted`);
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal label={`Delete task #${task.id}`} onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${panelTitle} mb-2 pr-6`}>Delete task #{task.id}</h2>
        <p className="text-muted">
          Delete this task permanently? Its runs and history will be removed. This cannot be undone.
        </p>
        {/* A mirrored Task's row would otherwise resurrect on the next tracker
            poll (it's just re-reading the still-open ticket) — the delete's
            tombstone (ADR-0025) is what actually prevents that, but the
            operator should know the tracker side of it too. */}
        {mirrored && (
          <p className="mt-2 text-muted">
            This task is mirrored from a tracker issue — it will also be dismissed there, so the next poll won't
            re-create it.
          </p>
        )}
        {error && <p className="mt-3 text-fail">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={btnDestructive} onClick={confirm} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
