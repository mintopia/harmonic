import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { DiscoveredHarnessModel, HarnessProvider } from '../types.js';
import { labelType, selectField } from '../ui.js';
import { ModelCombobox } from './ModelCombobox.js';

const fieldLabel = `mb-1 block ${labelType} text-muted`;

export function DiscoveryModelPicker({ harness, value, options, id, onChange }: { harness: string; value: string; options: string[]; id: string; onChange: (model: string) => void }) {
  const [providers, setProviders] = useState<HarnessProvider[]>([]);
  const [provider, setProvider] = useState('');
  const [models, setModels] = useState<DiscoveredHarnessModel[]>([]);
  useEffect(() => { let live = true; setProvider(''); setModels([]); api.harnessProviders(harness).then((r) => { if (live) setProviders(r.providers); }, () => { if (live) setProviders([]); }); return () => { live = false; }; }, [harness]);
  useEffect(() => { let live = true; if (!provider) return () => { live = false; }; api.harnessModels(harness, provider).then((r) => { if (live) setModels(r.models); }, () => { if (live) setModels([]); }); return () => { live = false; }; }, [harness, provider]);
  return <>{providers.length > 0 && <div className="mb-2"><label className={fieldLabel} htmlFor={`${id}-provider`}>Provider</label><select id={`${id}-provider`} className={`${selectField} w-full`} value={provider} onChange={(e) => setProvider(e.target.value)}><option value="">Curated models</option>{providers.map((item) => <option key={item.id} value={item.id}>{item.label}{item.authed ? '' : ' (not signed in)'}</option>)}</select></div>}<ModelCombobox id={id} value={value} onChange={onChange} options={[...new Set([...options, ...models.map((model) => model.id)])]} /></>;
}
