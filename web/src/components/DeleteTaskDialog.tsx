import { useState } from 'react';
import { api } from '../api';
import type { Task } from '../types';
import { toastSuccess } from '../toast';
import { Modal } from './Modal';
import { btnDestructive, panelTitle } from '../ui';
import { taskLabel } from '../id-format.js';

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
      toastSuccess(`${taskLabel(task.id)} deleted`);
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal label={`Delete ${taskLabel(task.id)}`} onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${panelTitle} mb-2 pr-6`}>Delete {taskLabel(task.id)}</h2>
        <p className="text-muted">
          Delete this task permanently? Its runs and history will be removed. This cannot be undone.
        </p>
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
