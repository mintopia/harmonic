import { useState } from 'react';
import { api } from '../api';
import { errorText } from '../error-text';
import { credentialPanelCopy, credentialRowView, type CredentialRowView } from '../execution-targets-model';
import type { ExecutionTarget, TargetCredential } from '../types';
import { btnPrimary, btnQuiet, field, statePillShape } from '../ui';
import { fieldLabel } from './SettingsSection';
import { Parts } from './execution-target-parts';

const smallBtn =
  'inline-flex min-h-8 items-center rounded-md border border-edge bg-surface px-2.5 py-0.5 text-small font-medium text-ink transition-colors hover:border-faint disabled:opacity-50';
const codeInline = 'rounded-sm bg-sunken px-1.5 font-data text-small';
const kindLabelClass = 'mr-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-faint';
const sectionLabel = 'mb-2 mt-5 text-label font-semibold uppercase text-muted';

const PILL_TONE: Record<CredentialRowView['pillTone'], string> = {
  set: 'bg-merged-tint text-merged',
  unset: 'bg-fail-tint text-fail',
  optional: 'bg-raised text-muted',
};

export function TargetCredentials({ target, onChanged }: { target: ExecutionTarget; onChanged: () => void }) {
  const [replacing, setReplacing] = useState<TargetCredential['harness'] | null>(null);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const credentials = target.credentials;
  const active = credentials.find((c) => c.harness === replacing) ?? null;

  const open = (harness: TargetCredential['harness']) => {
    setReplacing(harness);
    setValue('');
    setError(null);
  };

  const close = () => {
    setReplacing(null);
    setValue('');
    setError(null);
  };

  const save = () => {
    if (!active || !value.trim()) return;
    setSaving(true);
    setError(null);
    api.setExecutionTargetCredential(target.name, active.harness, value.trim()).then(
      () => {
        close();
        onChanged();
      },
      (e) => setError(errorText(e)),
    ).finally(() => setSaving(false));
  };

  const clear = (harness: TargetCredential['harness']) => {
    setError(null);
    api.clearExecutionTargetCredential(target.name, harness).then(() => {
      if (replacing === harness) close();
      onChanged();
    }, (e) => setError(errorText(e)));
  };

  const copy = active ? credentialPanelCopy(active) : null;

  return (
    <div className="pb-[18px]">
      <p className="mb-3 text-muted">
        One Secret per Harness. Harmonic injects it into a per-pod Kubernetes Secret when the pod starts and deletes it with the pod. A value never appears in
        logs or Activity, and is never shown here.
      </p>
      <div role="list" aria-label="Credentials" className="flex flex-col gap-1.5 rounded-lg border border-hairline bg-sunken p-1.5">
        {credentials.map((credential) => {
          const view = credentialRowView(credential);
          return (
            <div key={view.harness} role="listitem" className="grid grid-cols-1 items-center gap-3 rounded-lg bg-surface px-3.5 py-3 shadow-card md:grid-cols-[190px_minmax(0,1fr)_auto]">
              <div className="flex items-center gap-2.5">
                <span className="font-semibold">{view.label}</span>
                <span className={`${statePillShape} gap-1.5 whitespace-nowrap ${PILL_TONE[view.pillTone]}`}>
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
                  {view.pillLabel}
                </span>
              </div>
              <div>
                <span className={kindLabelClass}>{view.kindLabel}</span>
                {view.secretName && <code className={codeInline}>{view.secretName}</code>}{' '}
                {view.rotated && <span className="text-small text-muted">{view.rotated}</span>}
                {view.note && <span className="text-muted">{view.note}</span>}
              </div>
              <div className="flex items-center gap-1.5 md:justify-end">
                <button type="button" className={smallBtn} aria-label={`${view.replaceLabel.replace('…', '')} ${view.label}`} onClick={() => open(view.harness)}>
                  {view.replaceLabel}
                </button>
                {view.canClear && (
                  <button type="button" className={smallBtn} aria-label={`Clear ${view.label}`} onClick={() => clear(view.harness)}>Clear</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {active && copy && (
        <div>
          <div className={sectionLabel}>{copy.title}</div>
          <div className="flex max-w-xl flex-col gap-4">
            <div>
              <label htmlFor="credential-value" className={fieldLabel}>{copy.fieldLabel}</label>
              <input
                id="credential-value"
                type="password"
                className={`${field} min-h-11 font-data`}
                value={value}
                placeholder="Paste a token…"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setValue(e.target.value)}
              />
              <p className="mt-1 text-small text-faint"><Parts parts={copy.stored} codeClass={codeInline} /></p>
            </div>
            <div className="rounded-lg border border-hairline bg-sunken p-3.5">
              <div className="text-label font-semibold uppercase text-muted">{copy.help.label}</div>
              <p className="mb-2 mt-1.5">{copy.help.intro}</p>
              {copy.help.command && <div className="flex min-h-9 items-center rounded-md bg-surface px-3 font-data">{copy.help.command}</div>}
              <p className="mt-1.5 text-small text-faint">{copy.help.footnote}</p>
            </div>
            {error && <p role="alert" className="text-fail">{error}</p>}
            <div className="flex gap-2">
              <button type="button" className={btnPrimary} onClick={save} disabled={saving || !value.trim()}>{saving ? 'Saving…' : 'Save'}</button>
              <button type="button" className={btnQuiet} onClick={close} disabled={saving}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {!active && error && <p role="alert" className="mt-3 text-fail">{error}</p>}
    </div>
  );
}
