import { useState } from 'react';
import { api } from '../api.js';
import { labelType, selectField } from '../ui.js';
import { LoadErrorNote } from './LoadError.js';
import { ModelCombobox } from './ModelCombobox.js';
import { useAsyncResource } from '../useAsyncResource.js';
import { useLiveEffect } from '../useLiveEffect.js';

const fieldLabel = `mb-1 block ${labelType} text-muted`;

export function DiscoveryModelPicker({ harness, value, options, id, onChange }: { harness: string; value: string; options: string[]; id: string; onChange: (model: string) => void }) {
  const [provider, setProvider] = useState('');
  const providers = useAsyncResource(() => api.harnessProviders(harness), [harness]);
  const models = useAsyncResource(provider ? () => api.harnessModels(harness, provider) : null, [harness, provider]);
  useLiveEffect(() => setProvider(''), [harness]);
  const providerList = providers.data?.providers ?? [];
  const modelList = models.data?.models ?? [];
  return (
    <>
      {(providerList.length > 0 || providers.error) && (
        <div className="mb-2">
          {providerList.length > 0 && (
            <>
              <label className={fieldLabel} htmlFor={`${id}-provider`}>Provider</label>
              <select id={`${id}-provider`} className={`${selectField} w-full`} value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="">Curated models</option>
                {providerList.map((item) => <option key={item.id} value={item.id}>{item.label}{item.authed ? '' : ' (not signed in)'}</option>)}
              </select>
            </>
          )}
          {providers.error && <LoadErrorNote message={providers.error} onRetry={providers.reload} />}
        </div>
      )}
      <ModelCombobox id={id} value={value} onChange={onChange} options={[...new Set([...options, ...modelList.map((model) => model.id)])]} />
      {models.error && <LoadErrorNote message={`${models.error} — only curated models are listed`} onRetry={models.reload} />}
    </>
  );
}
