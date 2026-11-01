import type { ReactNode } from 'react';
import type { AppConfig } from '../types';
import { field, selectField } from '../ui';
import { FieldError, fieldLabel } from './SettingsSection';
import { providerLabel } from './TaskIdentity';
import { defaultHarnessId } from './verification-override-model';

type Classifier = AppConfig['classifier'];

const BACKENDS: ReadonlyArray<{ id: Classifier['backend']; label: string }> = [
  { id: 'harness', label: 'Harness' },
  { id: 'typesafe', label: 'TypeSafe decision model' },
  { id: 'openai-compatible', label: 'OpenAI-compatible endpoint' },
];

const pairValue = (harness: string, model: string) => JSON.stringify([harness, model]);

/** Global Route Classifier defaults: backend, Harness · model and timeout, with the Model Options list below. */
export function GlobalClassifierSettings({
  config,
  errors,
  onChange,
  children,
}: {
  config: AppConfig;
  errors: Record<string, string>;
  onChange: (config: AppConfig) => void;
  children?: ReactNode;
}) {
  const classifier = config.classifier;
  const set = (patch: Partial<Classifier>) => onChange({ ...config, classifier: { ...classifier, ...patch } });
  const harness = classifier.harness ?? defaultHarnessId(config);
  const model = classifier.model ?? config.harnesses[harness]?.defaultModel ?? '';
  const pairs = Object.entries(config.harnesses).flatMap(([id, h]) => h.models.map((m) => ({ harness: id, model: m.id })));
  if (!pairs.some((p) => p.harness === harness && p.model === model)) pairs.push({ harness, model });
  return (
    <div className="flex flex-col gap-3.5">
      <fieldset disabled={!classifier.enabled} className={`grid gap-3 pl-12 sm:grid-cols-3 ${classifier.enabled ? '' : 'opacity-55'}`}>
        <div>
          <label className={fieldLabel} htmlFor="classifier-backend">Backend</label>
          <select id="classifier-backend" className={`${selectField} w-full`} value={classifier.backend} onChange={(e) => set({ backend: e.target.value as Classifier['backend'] })}>
            {BACKENDS.map((b) => (
              <option key={b.id} value={b.id}>{b.label}</option>
            ))}
          </select>
          <FieldError message={errors['classifier.backend']} />
        </div>
        {classifier.backend === 'harness' && (
          <div>
            <label className={fieldLabel} htmlFor="classifier-harness-model">Harness · model</label>
            <select
              id="classifier-harness-model"
              className={`${selectField} w-full`}
              value={pairValue(harness, model)}
              onChange={(e) => {
                const [nextHarness, nextModel] = JSON.parse(e.target.value) as [string, string];
                set({ harness: nextHarness, model: nextModel });
              }}
            >
              {pairs.map((p) => (
                <option key={pairValue(p.harness, p.model)} value={pairValue(p.harness, p.model)}>{providerLabel(p.harness)} · {p.model}</option>
              ))}
            </select>
            <FieldError message={errors['classifier.harness'] ?? errors['classifier.model']} />
          </div>
        )}
        {classifier.backend === 'typesafe' && (
          <div>
            <label className={fieldLabel} htmlFor="classifier-secret-name">Secret name</label>
            <input
              id="classifier-secret-name"
              className={`${field} w-full font-data text-data`}
              value={classifier.typesafeSecret ?? ''}
              placeholder="OPENROUTER_API_KEY"
              onChange={(e) => set({ typesafeSecret: e.target.value.trim() || null })}
            />
            <FieldError message={errors['classifier.typesafeSecret']} />
          </div>
        )}
        {classifier.backend === 'openai-compatible' && (
          <p className="self-end text-small text-muted">The endpoint and its Secret are set in each Workspace.</p>
        )}
        <div>
          <label className={fieldLabel} htmlFor="classifier-timeout">Timeout (s)</label>
          <input
            id="classifier-timeout"
            type="number"
            min={1}
            className={`${field} w-full font-data text-data`}
            value={classifier.timeoutSeconds}
            onChange={(e) => set({ timeoutSeconds: Number(e.target.value) })}
          />
          <FieldError message={errors['classifier.timeoutSeconds']} />
        </div>
      </fieldset>
      {children && <div className="border-t border-hairline pt-3.5">{children}</div>}
    </div>
  );
}
