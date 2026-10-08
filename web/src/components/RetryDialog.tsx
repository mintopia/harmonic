import { useRef, useState } from 'react';
import { api } from '../api';
import { toastSuccess } from '../toast';
import { useDismissOnOutsidePointer } from '../useDismissOnOutsidePointer';
import { useLiveEffect } from '../useLiveEffect';
import { Modal } from './Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { ModelLabel, providerLabel } from './TaskIdentity';
import { harnessChoices, type HarnessChoices } from './verification-override-model';
import { btnGhost, btnPrimary, field, panelTitle, labelType } from '../ui';
import { taskLabel } from '../id-format.js';
import type { ContinuationPreview, Task } from '../types';

export interface RetryBody {
  guidance: string;
  startNow?: boolean;
  reuseSession?: boolean;
  harness?: string;
  model?: string;
}

interface Route {
  harness: string;
  model: string;
}

const NO_CHOICES: HarnessChoices = { defaultHarness: '', byId: {} };

function withCurrentRoute(choices: HarnessChoices, current: Route): HarnessChoices {
  const existing = choices.byId[current.harness] ?? { models: [], defaultModel: current.model };
  const models = existing.models.includes(current.model) ? existing.models : [current.model, ...existing.models];
  return { ...choices, byId: { ...choices.byId, [current.harness]: { ...existing, models } } };
}

const chipClass = 'ml-1.5 inline-flex align-middle items-center gap-1 rounded-full bg-tool-tint px-2 text-micro font-semibold text-tool';
const noteClass = 'text-small text-muted';
const chevron = (
  <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" className="shrink-0 text-faint">
    <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const warnClass = 'mb-3 rounded-sm bg-running-tint px-2.5 py-1.5 text-small text-running';

function RoutePicker({
  id,
  choices,
  value,
  current,
  label,
  disabled,
  onChange,
  onOpenChange,
}: {
  id: string;
  choices: HarnessChoices;
  value: Route;
  current: Route;
  label: string | null;
  disabled: boolean;
  onChange: (route: Route) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange(next);
  };
  const wrap = useRef<HTMLDivElement>(null);
  useDismissOnOutsidePointer(wrap, open, () => setOpen(false));
  const isCurrent = (harness: string, model: string) => harness === current.harness && model === current.model;
  const chip = label && isCurrent(value.harness, value.model) && (
    <span className={chipClass}>
      ↳ <code className="font-data">{label}</code>
    </span>
  );
  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        id={id}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className={`${field} flex min-h-11 items-center justify-between text-left`}
      >
        <span>
          {providerLabel(value.harness)} · <ModelLabel model={value.model} />
          {chip}
        </span>
        {chevron}
      </button>
      {open && (
        <ul role="listbox" aria-labelledby={`${id}-label`} className="absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-auto rounded-sm bg-surface py-1 shadow-float">
          {Object.entries(choices.byId).map(([harness, choice]) => (
            <li key={harness} role="presentation">
              <div className={`${labelType} px-2.5 pb-0.5 pt-1.5 text-faint`}>{providerLabel(harness)}</div>
              <ul role="group" aria-label={providerLabel(harness)}>
                {choice.models.map((model) => {
                  const selected = value.harness === harness && value.model === model;
                  return (
                    <li key={model} role="option" aria-selected={selected}>
                      <button
                        type="button"
                        className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left hover:bg-raised ${selected ? 'bg-raised' : ''}`}
                        onClick={() => {
                          onChange({ harness, model });
                          setOpen(false);
                        }}
                      >
                        <span>
                          <ModelLabel model={model} />
                          {label && isCurrent(harness, model) && (
                            <span className={chipClass}>
                              ↳ <code className="font-data">{label}</code>
                            </span>
                          )}
                        </span>
                        {selected ? <span className="text-accent">✓</span> : isCurrent(harness, model) ? <span className="text-micro text-faint">current</span> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RetryDialog({
  task,
  onClose,
  onDone,
  retry = (body) => api.retryTask(task.id, body),
  loadPreview,
  loadRoute,
}: {
  task: Pick<Task, 'id' | 'harness' | 'model' | 'routing'>;
  onClose: () => void;
  onDone: () => void;
  retry?: (body: RetryBody) => Promise<unknown>;
  loadPreview?: () => Promise<ContinuationPreview>;
  loadRoute?: () => Promise<HarnessChoices>;
}) {
  const current: Route = { harness: task.harness, model: task.model };
  const [choices, setChoices] = useState<HarnessChoices>(NO_CHOICES);
  const [route, setRoute] = useState<Route>(current);
  const [guidance, setGuidance] = useState('');
  const [when, setWhen] = useState<'later' | 'now'>('later');
  const [reuse, setReuse] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ContinuationPreview>({ available: false });
  const [confirmClose, setConfirmClose] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const requestClose = () => {
    if (busy) return;
    if (guidance.length > 0) setConfirmClose(true);
    else onClose();
  };

  useLiveEffect((live) => {
    (loadPreview ?? (() => api.continuationPreview(task.id)))()
      .then((p) => {
        if (live()) setPreview(p);
      })
      .catch((e) => console.warn('failed to load continuation preview', e));
  }, [loadPreview, task.id]);

  useLiveEffect((live) => {
    (loadRoute ?? (() => api.config().then(harnessChoices)))()
      .then((loaded) => {
        if (live()) setChoices(withCurrentRoute(loaded, { harness: task.harness, model: task.model }));
      })
      .catch((e) => console.warn('failed to load route options', e));
  }, [loadRoute, task.harness, task.model]);

  const harnessChanged = route.harness !== current.harness;
  const routeChanged = harnessChanged || route.model !== current.model;
  const canReuse = preview.available;
  const cold = preview.available && !preview.continueFull.estimate.warm;
  const now = when === 'now';
  const reusing = now && canReuse && reuse && !harnessChanged;
  const submitLabel = !now ? 'Retry' : reusing ? 'Retry Now in this Session' : 'Retry Now';
  const labelNote = task.routing?.applied ? task.routing.label : null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: RetryBody = { guidance: guidance.trim(), startNow: now };
      if (now) body.reuseSession = reusing;
      if (routeChanged) {
        body.harness = route.harness;
        body.model = route.model;
      }
      await retry(body);
      toastSuccess(
        reusing
          ? `${taskLabel(task.id)} retried — reusing the Session, starting now`
          : now
            ? `${taskLabel(task.id)} retried — starting now`
            : guidance.trim()
              ? `${taskLabel(task.id)} retried — guidance sent to the next attempt`
              : `${taskLabel(task.id)} retried`,
      );
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const seg = (value: 'later' | 'now', text: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={when === value}
      disabled={busy}
      onClick={() => setWhen(value)}
      className={`flex-1 px-2.5 py-2 text-center ${when === value ? 'bg-accent font-semibold text-on-accent' : 'bg-field font-medium text-muted'} ${value === 'now' ? 'border-l border-edge' : ''}`}
    >
      {text}
    </button>
  );

  return (
    <>
      <Modal label={`Retry ${taskLabel(task.id)}`} onClose={onClose} onRequestClose={requestClose} className={`max-w-md ${pickerOpen ? 'overflow-visible' : ''}`}>
        <div className="p-5">
          <h2 className={`${panelTitle} mb-1`}>Retry {taskLabel(task.id)}</h2>
          <p className="mb-4 text-muted">
            Sends the ticket back to the queue on the same branch; the attempt budget starts over. Optional guidance is
            recorded on the escalated attempt and given to the next one.
          </p>
          <div className="mb-4">
            <label className={`${labelType} mb-1 block text-muted`} htmlFor="retry-guidance">
              Guidance (optional)
            </label>
            <textarea
              id="retry-guidance"
              autoFocus
              rows={4}
              disabled={busy}
              className={`${field} block resize-y`}
              placeholder="What was wrong, and what the next attempt should do differently…"
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
            />
          </div>
          <div className="mb-4">
            <span id="retry-route-label" className={`${labelType} mb-1 block text-muted`}>
              Harness and Model
            </span>
            <RoutePicker
              id="retry-route"
              choices={choices}
              value={route}
              current={current}
              label={labelNote}
              disabled={busy}
              onChange={setRoute}
              onOpenChange={setPickerOpen}
            />
            {routeChanged && (
              <p className={`${noteClass} mt-2`}>
                Saved on this Ticket.
                {labelNote && (
                  <>
                    {' '}Label <code className="rounded-sm bg-tool-tint px-1.5 font-data text-tool">{labelNote}</code> will no longer apply.
                  </>
                )}
              </p>
            )}
          </div>
          <div className="mb-4">
            <span className={`${labelType} mb-1 block text-muted`}>When</span>
            <div role="radiogroup" aria-label="When" className="mb-2.5 flex overflow-hidden rounded-sm border border-edge">
              {seg('later', 'Retry')}
              {seg('now', 'Retry Now')}
            </div>
            {!now && <p className={noteClass}>Queues the next Attempt. It continues the current Session if that is still warm and you kept the same Harness and Model.</p>}
            {now && canReuse && (
              <>
                <label className={`mb-2 flex items-start gap-2 ${harnessChanged ? 'text-faint' : ''}`}>
                  <input
                    type="checkbox"
                    className="mt-1 accent-accent"
                    checked={reusing}
                    disabled={busy || harnessChanged}
                    onChange={(e) => setReuse(e.target.checked)}
                  />
                  <span>Re-use the same Session</span>
                </label>
                {harnessChanged && <p className={`${noteClass} ml-6`}>Different Harness: needs a new Session.</p>}
                {reusing && !harnessChanged && route.model !== current.model && (
                  <p className={warnClass}>Switching Model in this Session costs more: the cached context can&apos;t be reused.</p>
                )}
                {reusing && cold && <p className={warnClass}>This Session is cold, so re-using it costs more than usual.</p>}
                {reusing && !cold && route.model === current.model && (
                  <p className={`${noteClass} ml-6`}>Session is warm: the cached context is reused.</p>
                )}
              </>
            )}
          </div>
          {error && <p role="alert" className="mb-3 text-fail">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={`${btnGhost} px-3 py-1.5`} onClick={requestClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" onClick={submit} disabled={busy} className={`${btnPrimary} px-3 py-1.5`}>
              {submitLabel}
            </button>
          </div>
        </div>
      </Modal>
      {confirmClose && (
        <ConfirmDialog
          label="Discard retry guidance"
          title="Discard unsent guidance?"
          confirmLabel="Discard"
          tone="danger"
          onConfirm={onClose}
          onCancel={() => setConfirmClose(false)}
        >
          Your retry guidance will be lost.
        </ConfirmDialog>
      )}
    </>
  );
}
