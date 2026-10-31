import { useCallback, useState } from 'react';
import { parseWorkflow } from '../../../src/domain/workflow.js';
import { api } from '../api';
import type { TaskWorkflowVars, Workspace } from '../types';
import { btnGhost, btnPrimary, card } from '../ui';
import { parseWorkflowRef } from '../workflow-ref-model';
import { useAsyncResource } from '../useAsyncResource';
import { VariablesTable } from './VariablesTable';
import {
  defaultHint,
  overridesFrom,
  ticketInherited,
  ticketVarRows,
  withWorkflowOverrides,
  workspaceVarRows,
  type VarRow,
  type VarValue,
} from './workflow-vars-model';

const SECRETS_NOTE = (
  <div className="mt-3 rounded-md bg-sunken px-3 py-2 text-small text-muted">
    <span className="font-semibold text-ink">Secrets are never variables.</span> Reference a Secret as <code className="font-data">secrets.NAME</code> in a step; its value is masked in logs.
  </div>
);

async function declaredVars(): Promise<{ name: string; vars: Record<string, VarValue> }[]> {
  const { workflows } = await api.workflows();
  const loaded = await Promise.all(
    workflows.map(async ({ name }) => {
      try {
        return { name, vars: { ...parseWorkflow((await api.workflow(name)).text).vars } };
      } catch {
        return { name, vars: {} };
      }
    }),
  );
  return loaded.filter((entry) => Object.keys(entry.vars).length > 0);
}

export function WorkspaceWorkflowVars({ workspace, onChange }: { workspace: Workspace; onChange: (workflowVars: Workspace['workflowVars']) => void }) {
  const declared = useAsyncResource(declaredVars, []).data ?? [];
  if (declared.length === 0) return <p className="text-muted">No workflow in the Library declares variables.</p>;
  return (
    <div className="flex flex-col gap-5">
      {declared.map(({ name, vars }) => (
        <section key={name} aria-label={`Variables for ${name}`} className={`${card} p-5`}>
          <h3 className="text-title font-semibold">Variables for “{name}”</h3>
          <p className="mb-4 mt-0.5 text-muted">Overrides apply to every Ticket in this Workspace that uses a workflow declaring the variable.</p>
          <VariablesTable
            level="workspace"
            rows={workspaceVarRows(vars, workspace.workflowVars?.[name])}
            defaultCell={(row) => String(row.default)}
            inheritedFor={(row) => ({ value: row.default, source: 'default' })}
            onChange={(rows) => onChange(withWorkflowOverrides(workspace.workflowVars, name, overridesFrom(rows, 'workspace')))}
          />
          {SECRETS_NOTE}
        </section>
      ))}
    </div>
  );
}

export function TicketVariables({ taskId }: { taskId: number }) {
  const resource = useAsyncResource(() => api.workflowVars(taskId), [taskId]);
  const [draft, setDraft] = useState<VarRow[] | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onInvalid = useCallback((value: boolean) => setInvalid(value), []);
  const data: TaskWorkflowVars | null = resource.data;
  if (!data || data.workflow === null || data.vars.length === 0) return null;
  const version = data.workflowRef ? parseWorkflowRef(data.workflowRef).version : null;
  const rows = draft ?? ticketVarRows(data.vars);
  const byName = new Map(data.vars.map((entry) => [entry.name, entry]));
  const inherited = (row: VarRow) => ticketInherited(byName.get(row.name)!);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.setWorkflowVars(taskId, overridesFrom(rows, 'ticket'));
      setDraft(null);
      resource.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section aria-label="Variables" className={`${card} p-5`}>
      <h2 className="text-title font-semibold">Variables</h2>
      <p className="mb-4 mt-0.5 text-muted">
        Only variables declared by {data.workflow}
        {version !== null ? ` v${version}` : ''}. Takes effect from the next Retry.
      </p>
      <VariablesTable level="ticket" rows={rows} defaultCell={(row) => defaultHint(byName.get(row.name)!)} inheritedFor={inherited} onChange={setDraft} onInvalid={onInvalid} />
      {error && (
        <p role="alert" className="mt-2 text-small text-fail">
          {error}
        </p>
      )}
      {draft && (
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className={btnGhost} onClick={() => setDraft(null)}>
            Cancel
          </button>
          <button type="button" disabled={invalid || saving} className={btnPrimary} onClick={save}>
            Save
          </button>
        </div>
      )}
      {SECRETS_NOTE}
    </section>
  );
}
