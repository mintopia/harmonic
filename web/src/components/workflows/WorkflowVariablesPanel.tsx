import { useState } from 'react';
import { api } from '../../api';
import { useAsyncResource } from '../../useAsyncResource';
import { btnGhost, field, labelType, selectField } from '../../ui';
import { addVar, overriddenIn, readVars, removeVar, setVar } from '../../workflow-yaml-vars-model';

export function WorkflowVariablesPanel({ name, text, onChange }: { name: string; text: string; onChange: (text: string) => void }) {
  const workspaces = useAsyncResource(() => api.workspaces(), []);
  const [draftName, setDraftName] = useState('');
  const vars = readVars(text);
  const overrides = workspaces.data?.workspaces ?? [];
  const duplicate = vars.some((v) => v.name === draftName.trim());
  const add = () => {
    onChange(addVar(text, draftName.trim(), ''));
    setDraftName('');
  };

  return (
    <section aria-label="Workflow variables" className="flex flex-col gap-2.5 px-4">
      <p className="m-0 text-small text-muted">
        Declared in <code className="font-data">vars:</code>. Settings and Tickets can override these values; the type comes from the default.
      </p>
      {vars.length > 0 && (
        <table className="w-full text-small">
          <thead>
            <tr className="text-left">
              <th className={`${labelType} py-1.5 pr-3 text-muted`}>Variable</th>
              <th className={`${labelType} py-1.5 pr-3 text-muted`}>Type</th>
              <th className={`${labelType} py-1.5 pr-3 text-muted`}>Default</th>
              <th className={`${labelType} py-1.5 pr-3 text-muted`}>Overridden in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {vars.map((v) => {
              const where = overriddenIn(name, v.name, overrides);
              return (
                <tr key={v.name} className="border-t border-hairline">
                  <td className="py-1.5 pr-3 font-data font-semibold text-ink">{v.name}</td>
                  <td className="py-1.5 pr-3 text-muted">{v.type}</td>
                  <td className="py-1.5 pr-3">
                    {v.type === 'boolean' ? (
                      <select aria-label={`Default for ${v.name}`} className={`${selectField} w-30`} value={v.value} onChange={(e) => onChange(setVar(text, v.name, e.target.value))}>
                        <option>true</option>
                        <option>false</option>
                      </select>
                    ) : (
                      <input aria-label={`Default for ${v.name}`} className={`${field} font-data`} value={v.value} onChange={(e) => onChange(setVar(text, v.name, e.target.value))} />
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-muted">{where.length === 0 ? '—' : `Global · ${where.join(', ')}`}</td>
                  <td className="py-1.5 text-right">
                    <button type="button" className={btnGhost} aria-label={`Remove ${v.name}`} onClick={() => onChange(removeVar(text, v.name))}>
                      Remove
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (draftName.trim() !== '' && !duplicate) add();
        }}
      >
        <input aria-label="New variable name" className={field} placeholder="new_var" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
        <button type="submit" className={btnGhost} disabled={draftName.trim() === '' || duplicate}>
          + Add variable
        </button>
        {duplicate && <span className="text-small text-fail">A variable with that name already exists.</span>}
      </form>
    </section>
  );
}
