import { useState } from 'react';
import { api } from '../../api';
import { useAsyncResource } from '../../useAsyncResource';
import { btnGhost, btnPrimary, field, labelType, panelTitle } from '../../ui';
import { taskLabel } from '../../id-format.js';
import { Modal } from '../Modal';

export const UNCONFIGURED_HARNESS = /not configured/;

function SetHarnessDialog({ taskId, onClose, onDone }: { taskId: number; onClose: () => void; onDone: () => void }) {
  const config = useAsyncResource(() => api.config(), []);
  const names = Object.keys(config.data?.harnesses ?? {});
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const harness = choice || names[0] || '';

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updateTask(taskId, { harness });
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Modal label={`Set Harness on ${taskLabel(taskId)}`} onClose={onClose} className="max-w-md">
      <div className="p-5">
        <h2 className={`${panelTitle} mb-1`}>Set Harness on {taskLabel(taskId)}</h2>
        <p className="mb-4 text-muted">Overrides the Routing Label for this Ticket only.</p>
        <label className={`${labelType} mb-1 block text-muted`} htmlFor="set-harness">
          Harness
        </label>
        <select
          id="set-harness"
          className={`${field} mb-4`}
          disabled={busy}
          value={harness}
          onChange={(e) => setChoice(e.target.value)}
        >
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        {error && <p role="alert" className="mb-3 text-fail">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={`${btnGhost} px-3 py-1.5`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`${btnPrimary} px-3 py-1.5`} onClick={save} disabled={busy || !harness}>
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function UnconfiguredHarnessGate({ taskId, onChanged }: { taskId: number; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.rejectTask(taskId, '');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-hairline pt-2">
        <span className="text-muted">Setting a Harness on the Ticket overrides the label for this Ticket only.</span>
        <span className="flex-1" />
        <button type="button" className={btnGhost} disabled={busy} onClick={() => setOpen(true)}>
          Set Harness on this Ticket…
        </button>
        <button type="button" className={btnPrimary} disabled={busy} onClick={retry}>
          Retry
        </button>
      </div>
      {error && <p role="alert" className="mt-1 text-fail">{error}</p>}
      {open && (
        <SetHarnessDialog
          taskId={taskId}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            onChanged();
          }}
        />
      )}
    </>
  );
}
