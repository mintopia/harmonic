import { useState } from 'react';
import { api } from '../../api';
import { useAsyncResource } from '../../useAsyncResource';
import { btnGhost, btnPrimary, field, labelType, panelTitle } from '../../ui';
import { taskLabel } from '../../id-format.js';
import { Modal } from '../Modal';

const UNCONFIGURED_HARNESS = /^(?:Routing Label '(.+)' needs )?Harness '([^']+)'(?: is|,) (?:which is )?not configured\.$/;

export function parseUnconfiguredHarness(reason: string): { label: string | null; harness: string } | null {
  const m = UNCONFIGURED_HARNESS.exec(reason.trim());
  return m ? { label: m[1] ?? null, harness: m[2]! } : null;
}

export function UnconfiguredHarnessMessage({ label, harness }: { label: string | null; harness: string }) {
  const code = 'rounded-[3px] bg-surface px-1.5 font-data text-small text-ink';
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

export function UnconfiguredHarnessGate({ taskId, onChanged, onClose }: { taskId: number; onChanged: () => void; onClose?: () => void }) {
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
      <div className="mt-4 flex flex-wrap items-center gap-2.5 rounded-b-lg border-t border-hairline bg-surface px-3.5 py-3 shadow-float">
        <span className="text-small text-muted">Setting a Harness on the Ticket overrides the label for this Ticket only.</span>
        <span className="flex-1" />
        {onClose && (
          <button type="button" className="px-2 py-1 text-muted hover:text-ink" onClick={onClose}>
            Close
          </button>
        )}
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
