import { useState } from 'react';
import { api } from '../../api';
import { useAsyncResource } from '../../useAsyncResource';
import { btnGhost, btnPrimary, codeChip, field, labelType, panelTitle } from '../../ui';
import { taskLabel } from '../../id-format.js';
import { Modal } from '../Modal';
import { providerLabel } from '../TaskIdentity';

export function UnconfiguredHarnessMessage({ label, harness }: { label: string | null; harness: string }) {
  const code = `${codeChip} bg-surface text-ink`;
  return (
    <>
      {label ? (
        <>
          Routing Label <code className={code}>{label}</code> routes to Harness <code className={code}>{harness}</code>, which is not configured.
        </>
      ) : (
        <>
          Harness <code className={code}>{harness}</code> is not configured.
        </>
      )}{' '}
      No Attempt was started. Configure the Harness in Global settings › Integrations › Harnesses,{' '}
      {label ? "change the label's route in Settings › Execution › Routing Labels, " : ''}or set a Harness on this Ticket.
    </>
  );
}

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
              {providerLabel(n)}
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

export function UnconfiguredHarnessGate({ taskId, onChanged, onClose }: { taskId: number; onChanged: () => void; onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.retryTask(taskId, { guidance: 'Retry after changing the route.' });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-2 rounded-b-lg border-t border-hairline bg-surface px-3.5 py-3 shadow-float">
        <span className="min-w-48 flex-1 text-small text-muted">Setting a Harness on the Ticket overrides the label for this Ticket only.</span>
        <span className="ml-auto flex flex-wrap items-center justify-end gap-2.5">
          {onClose && (
            <button type="button" className="min-h-11 px-2 text-muted hover:text-ink" onClick={onClose}>
              Close
            </button>
          )}
          <button type="button" className={btnGhost} disabled={busy} onClick={() => setOpen(true)}>
            Set Harness on this Ticket…
          </button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={retry}>
            Retry
          </button>
        </span>
      </div>
      {error && <p role="alert" className="mt-2 text-small text-fail">{error}</p>}
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
