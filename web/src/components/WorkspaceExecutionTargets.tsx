import { api } from '../api';
import { useAsyncResource } from '../useAsyncResource';
import type { Workspace } from '../types';
import { toggleTarget, workspaceRows } from '../execution-targets-model';
import { Switch } from './Switch';
import { LoadError } from './LoadError';
import { FieldError } from './SettingsSection';

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
  if (!view.data) return <p role="status" className="text-muted">Loading Execution Targets…</p>;

  const { targets, codeRepository, isolationMode } = view.data;
  const override = workspace.executionTargets;
  const rows = workspaceRows(targets, override, codeRepository, isolationMode);

  return (
    <div>
      <div className="flex flex-col gap-1.5 rounded-lg border border-hairline bg-sunken p-1.5">
        {rows.map((row) => (
          <div key={row.name} className="rounded-lg bg-surface px-3.5 py-2.5 shadow-card">
            <div className="grid grid-cols-[auto_minmax(100px,1fr)] items-center gap-3 md:grid-cols-[auto_minmax(140px,1fr)_2fr]">
              <Switch
                checked={row.on}
                disabled={row.builtIn}
                label={row.name}
                onChange={(on) => onChange(toggleTarget(override, targets, row.name, on))}
              />
              <span className="font-data">{row.name}</span>
              <span className="col-span-2 text-small text-muted md:col-span-1">{row.note}</span>
            </div>
            {row.refusal && (
              <p role="alert" className="mt-2 text-label text-fail">
                {row.refusal.text}
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
    </div>
  );
}
