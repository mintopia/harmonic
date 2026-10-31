import { api } from '../api';
import { useAsyncResource } from '../useAsyncResource';
import type { Workspace } from '../types';
import { toggleTarget, workspaceRows } from '../execution-targets-model';
import { card, sectionTitle } from '../ui';
import { Switch } from './Switch';
import { LoadError } from './LoadError';
import { FieldError } from './SettingsSection';
import { Parts } from './execution-target-parts';

export function WorkspaceExecutionTargets({
  workspace,
  savedKey,
  error,
  onChange,
  onAddRepository,
}: {
  workspace: Workspace;
  savedKey: string;
  error?: string | undefined;
  onChange: (executionTargets: string[] | null) => void;
  onAddRepository?: (() => void) | undefined;
}) {
  const view = useAsyncResource(() => api.workspaceExecutionTargets(workspace.id), [workspace.id, savedKey]);
  if (view.error && !view.data) return <LoadError message={`execution targets: ${view.error}`} onRetry={view.reload} />;
  if (!view.data) return <p role="status" className="p-4 text-muted">Loading Execution Targets…</p>;

  const { targets, codeRepository, isolationMode } = view.data;
  const override = workspace.executionTargets;
  const rows = workspaceRows(targets, override, codeRepository, isolationMode);

  return (
    <section className={`${card} p-5`}>
      <h2 className={sectionTitle}>Execution Targets</h2>
      <p className="mb-4 mt-0.5 text-muted">
        Restrict which targets this Workspace may use. <code className="rounded-sm bg-sunken px-1.5 font-data text-small">local</code> is always available.
      </p>
      <div className="flex flex-col gap-1.5 rounded-lg border border-hairline bg-sunken p-1.5">
        {rows.map((row) => (
          <div key={row.name} className="rounded-lg bg-surface px-3.5 py-3.5 shadow-card">
            <div className="grid grid-cols-[24px_minmax(100px,1fr)] items-center gap-3 md:grid-cols-[24px_minmax(140px,1fr)_2fr]">
              <span className="[&_button:disabled]:opacity-100">
                <Switch
                  checked={row.on}
                  disabled={row.builtIn}
                  label={row.name}
                  onChange={(on) => onChange(toggleTarget(override, targets, row.name, on))}
                />
              </span>
              <span className="font-data text-[13px]">{row.name}</span>
              <span className="col-span-2 text-small text-muted md:col-span-1">
                <Parts parts={row.note} codeClass="font-data text-[13px]" />
              </span>
            </div>
            {row.refusal && (
              <p role="alert" className="mt-1 text-small text-fail">
                <Parts parts={row.refusal.parts} codeClass="font-data text-[13px]" />
                {row.refusal.link && (
                  <>
                    {' '}
                    <button type="button" className="font-semibold text-accent underline underline-offset-2" onClick={onAddRepository}>
                      {row.refusal.link}
                    </button>
                  </>
                )}
              </p>
            )}
          </div>
        ))}
      </div>
      <FieldError message={error} />
    </section>
  );
}
