import { useState } from 'react';
import { api } from '../../api';
import { useAsyncResource } from '../../useAsyncResource';
import { btnGhost, field, labelType } from '../../ui';
import { addVar, overriddenIn, readVars, removeVar, setVar } from '../../workflow-yaml-vars-model';

export function WorkflowVariablesPanel({ name, text, readOnly, onChange }: { name: string; text: string; readOnly: boolean; onChange: (text: string) => void }) {
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
    <section aria-label="Workflow variables" className="px-3.5 pb-3">
      {vars.length === 0 ? (
        <p className="py-2 text-small text-muted">
          This workflow declares no <code className="font-data">vars:</code>. Declared vars become defaults a Workspace or Ticket can override.
        </p>
      ) : (
        <table className="w-full text-small">
          <thead>
            <tr className="text-left">
              <th className={`${labelType} py-1.5 pr-3 text-muted`}>Name</th>
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
                    <input aria-label={`Default for ${v.name}`} className={field} value={v.value} readOnly={readOnly} onChange={(e) => onChange(setVar(text, v.name, e.target.value))} />
                  </td>
                  <td className="py-1.5 pr-3 text-muted">{where.length === 0 ? 'Not overridden' : `Workspace · ${where.join(', ')}`}</td>
                  <td className="py-1.5 text-right">
                    {!readOnly && (
                      <button type="button" className={btnGhost} aria-label={`Remove ${v.name}`} onClick={() => onChange(removeVar(text, v.name))}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {!readOnly && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draftName.trim() !== '' && !duplicate) add();
          }}
        >
          <input aria-label="New variable name" className={field} placeholder="new_var" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
          <button type="submit" className={btnGhost} disabled={draftName.trim() === '' || duplicate}>
            Add variable
          </button>
          {duplicate && <span className="text-small text-fail">A variable with that name already exists.</span>}
        </form>
      )}
    </section>
  );
}
