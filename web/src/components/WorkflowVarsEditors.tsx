import { useCallback, useState, type ReactNode } from 'react';
import { parseWorkflow } from '../../../src/domain/workflow.js';
import { api } from '../api';
import type { TaskWorkflowVars, Workspace } from '../types';
import { btnGhost, btnPrimary, card } from '../ui';
import { parseWorkflowRef } from '../workflow-ref-model';
import { useAsyncResource } from '../useAsyncResource';
import { VariablesTable } from './VariablesTable';
import { Icon } from './Icon';
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

function WorkspaceVarsCard({ workspace, name, vars, picker, onChange }: { workspace: Workspace; name: string; vars: Record<string, VarValue>; picker: ReactNode; onChange: (workflowVars: Workspace['workflowVars']) => void }) {
  const [draft, setDraft] = useState<VarRow[] | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onInvalid = useCallback((value: boolean) => setInvalid(value), []);
  const rows = draft ?? workspaceVarRows(vars, workspace.workflowVars?.[name]);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = withWorkflowOverrides(workspace.workflowVars, name, overridesFrom(rows, 'workspace'));
      await api.updateWorkspace(workspace.id, { workflowVars: next });
      onChange(next);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section aria-label={`Variables for ${name}`} className={`${card} p-5`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-title font-semibold">Workflow variables</h3>
          <p className="mt-0.5 text-muted">
            Override a workflow’s <code className="font-data">vars:</code> defaults. Ticket → Workspace → Global → workflow default; fixed when the Ticket snapshots.
          </p>
        </div>
        {picker}
      </div>
      <VariablesTable
        level="workspace"
        rows={rows}
        defaultCell={(row) => String(row.default)}
        inheritedFor={(row) => ({ value: row.default, source: 'default' })}
        onChange={setDraft}
        onInvalid={onInvalid}
      />
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

export function WorkspaceWorkflowVars({ workspace, onChange }: { workspace: Workspace; onChange: (workflowVars: Workspace['workflowVars']) => void }) {
  const declared = useAsyncResource(declaredVars, []).data ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  if (declared.length === 0) return <p className="text-muted">No workflow in the Library declares variables.</p>;
  const current = declared.find((entry) => entry.name === picked) ?? declared[0]!;
  const picker = (
    <select
      aria-label="Workflow"
      className="hm-select min-h-9 rounded-md border border-edge bg-field px-2.5 py-1 text-ink focus:border-accent focus:outline-none"
      value={current.name}
      onChange={(e) => setPicked(e.target.value)}
    >
      {declared.map(({ name }) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
  return <WorkspaceVarsCard key={current.name} workspace={workspace} name={current.name} vars={current.vars} picker={picker} onChange={onChange} />;
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
  const overridden = data.vars.filter((entry) => !ticketInherited(entry)).length;
  return (
    <details aria-label="Variables" className="group/vars mb-4" open={draft !== null || undefined}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-2 [&::-webkit-details-marker]:hidden">
        <Icon name="chevron-down" className="size-3.5 -rotate-90 text-faint transition-transform group-open/vars:rotate-0" />
        <h2 className="text-title font-semibold">Variables</h2>
        <span className="text-small text-muted tabular-nums">
          {data.vars.length} declared{overridden > 0 ? ` · ${overridden} set on this Ticket` : ''}
        </span>
      </summary>
      <div className="pb-4 pl-[22px]">
      <p className="mb-3 text-small text-muted">
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
      </div>
    </details>
  );
}
