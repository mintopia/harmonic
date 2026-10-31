import { useRef, useState } from 'react';
import { api } from '../../api';
import { toastError, toastSuccess } from '../../toast';
import { useAsyncResource } from '../../useAsyncResource';
import type { WorkflowLibraryEntry } from '../../types';
import { btnGhost, btnPrimary, card, field, labelType, searchField, sectionTitle } from '../../ui';
import { ConfirmDialog } from '../ConfirmDialog';
import { EmptyState } from '../EmptyState';
import { LoadError } from '../LoadError';
import { Modal } from '../Modal';
import { PageHeader } from '../PageHeader';
import { downloadText } from './download';
import { WorkflowEditor } from './WorkflowEditor';
import { assignedChips, deleteBlock, filterWorkflows, importRefusal, inUseText, type ChipTone } from './workflows-model';

const CHIP_STYLES: Record<ChipTone, string> = {
  neutral: 'bg-raised text-muted',
  global: 'bg-accent-tint text-accent',
  workspace: 'bg-ready-tint text-ready',
  label: 'bg-accent-tint text-accent',
};

const rowLink = 'inline-flex min-h-11 items-center px-1.5 text-small font-semibold text-accent transition-colors hover:text-accent-hot';

export function WorkflowsPage() {
  const library = useAsyncResource(() => api.workflows(), []);
  const [open, setOpen] = useState<string | null>(null);
  const entries = library.data?.workflows ?? [];
  const openEntry = open === null ? null : entries.find((e) => e.name === open) ?? null;

  if (openEntry !== null) {
    return (
      <WorkflowEditor entry={openEntry} onBack={() => setOpen(null)} onChanged={library.reload} onOpen={setOpen} />
    );
  }
  return <Library entries={entries} loading={library.loading} error={library.error} reload={library.reload} onOpen={setOpen} hasData={library.data !== null} />;
}

function Library({
  entries,
  loading,
  error,
  hasData,
  reload,
  onOpen,
}: {
  entries: WorkflowLibraryEntry[];
  loading: boolean;
  error: string | null;
  hasData: boolean;
  reload: () => void;
  onOpen: (name: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<WorkflowLibraryEntry | null>(null);
  const [creating, setCreating] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const visible = filterWorkflows(entries, query);

  const duplicate = (name: string) => {
    api.duplicateWorkflow(name).then((copy) => {
      reload();
      onOpen(copy.name);
    }, toastError);
  };

  const exportYaml = (name: string) => {
    api.exportWorkflow(name).then((text) => downloadText(`${name}.yaml`, text), toastError);
  };

  const importFile = async (file: File) => {
    try {
      await api.importWorkflow(await file.text());
      toastSuccess(`Imported ${file.name}`);
      reload();
    } catch (e) {
      toastError(new Error(importRefusal(file.name, e)));
    }
  };

  const remove = (entry: WorkflowLibraryEntry) => {
    setDeleting(null);
    api.deleteWorkflow(entry.name).then(() => {
      toastSuccess(`Deleted ${entry.name}`);
      reload();
    }, toastError);
  };

  return (
    <div>
      <PageHeader title="Workflows" description="Task Execution Workflows: one global library, each workflow its own YAML file in Harmonic's data directory." />
      <section className={`${card} p-5`}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className={sectionTitle}>Workflows</h2>
          <span className="flex-1" />
          <input
            type="search"
            aria-label="Search workflows"
            placeholder="Search workflows"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={`${searchField} w-60`}
          />
          <button type="button" className={btnGhost} onClick={() => picker.current?.click()}>
            Import YAML…
          </button>
          <input
            ref={picker}
            type="file"
            accept=".yaml,.yml,application/yaml,text/yaml"
            aria-label="Import workflow YAML file"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importFile(file);
            }}
          />
          <button type="button" className={btnPrimary} onClick={() => setCreating(true)} disabled={!entries.some((e) => e.bundled)}>
            New workflow
          </button>
        </div>
        {error !== null && !hasData && <LoadError message={error} onRetry={reload} />}
        {loading && !hasData && <p className="text-muted">Loading workflows…</p>}
        {hasData && visible.length === 0 && (
          <EmptyState
            title={query.trim() === '' ? 'No workflows yet' : `No workflow matches “${query.trim()}”`}
            className="py-8"
            action={
              query.trim() === '' ? undefined : (
                <button type="button" className="font-semibold text-accent hover:text-accent-hot" onClick={() => setQuery('')}>
                  Clear search
                </button>
              )
            }
          >
            {query.trim() === '' ? 'Create one or import a YAML file.' : 'Search looks at names.'}
          </EmptyState>
        )}
        {visible.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className={`${labelType} text-muted`}>
                  <th className="py-2 pr-4 font-semibold">Name</th>
                  <th className="py-2 pr-4 font-semibold">Version</th>
                  <th className="py-2 pr-4 font-semibold">In use</th>
                  <th className="py-2 pr-4 font-semibold">Assigned as</th>
                  <th className="py-2 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((entry) => {
                  const blocked = deleteBlock(entry);
                  return (
                    <tr key={entry.name} className="border-t border-hairline align-top">
                      <td className="py-2.5 pr-4">
                        <button type="button" className="inline-flex min-h-11 items-center gap-2 text-left font-bold text-ink hover:text-accent" onClick={() => onOpen(entry.name)}>
                          {entry.name}
                          {entry.bundled && <span className="rounded-sm bg-raised px-2 py-0.5 text-label font-semibold uppercase text-muted">Bundled</span>}
                        </button>
                      </td>
                      <td className="py-2.5 pr-4 font-data text-small leading-[2.75rem]">v{entry.version}</td>
                      <td className="py-2.5 pr-4 leading-[2.75rem]">{inUseText(entry.inUse)}</td>
                      <td className="py-2.5 pr-4">
                        <div className="flex min-h-11 flex-wrap items-center gap-1">
                          {assignedChips(entry).map((c) => (
                            <span key={c.text} className={`rounded-full px-2 py-0.5 text-label font-semibold tracking-normal ${CHIP_STYLES[c.tone]}`}>
                              {c.text}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-2.5">
                        <div className="flex items-center justify-end gap-1">
                          <button type="button" className={rowLink} onClick={() => duplicate(entry.name)}>
                            Duplicate
                          </button>
                          <button type="button" className={rowLink} onClick={() => exportYaml(entry.name)}>
                            Export
                          </button>
                          <button
                            type="button"
                            disabled={blocked !== null}
                            aria-describedby={blocked ? `why-${entry.name}` : undefined}
                            className={`${rowLink} ${blocked ? 'cursor-not-allowed font-medium text-faint line-through hover:text-faint' : 'text-fail hover:text-fail'}`}
                            onClick={() => setDeleting(entry)}
                          >
                            Delete
                          </button>
                        </div>
                        {blocked && (
                          <p id={`why-${entry.name}`} className="ml-auto max-w-52 text-right text-label text-faint">
                            {blocked}
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-small text-faint">
          Each workflow is a YAML file in the data directory. Export downloads the saved YAML; Import creates a new workflow and refuses invalid YAML.
        </p>
      </section>
      {deleting && (
        <ConfirmDialog label={`Delete ${deleting.name}`} title={`Delete “${deleting.name}”?`} confirmLabel="Delete workflow" tone="danger" onConfirm={() => remove(deleting)} onCancel={() => setDeleting(null)}>
          Deleting removes its YAML file from the data directory and cannot be undone.
        </ConfirmDialog>
      )}
      {creating && (
        <NewWorkflowDialog
          template={entries.find((e) => e.bundled)?.name ?? ''}
          onCancel={() => setCreating(false)}
          onCreated={(name) => {
            setCreating(false);
            reload();
            onOpen(name);
          }}
        />
      )}
    </div>
  );
}

function NewWorkflowDialog({ template, onCancel, onCreated }: { template: string; onCancel: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      onCreated((await api.duplicateWorkflow(template, name.trim())).name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal label="New workflow" onClose={onCancel} className="max-w-md">
      <form
        className="p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() !== '' && !busy) void create();
        }}
      >
        <h2 className="mb-2 pr-6 font-display text-display font-display-weight">New workflow</h2>
        <p className="mb-3 text-muted">Starts as an editable copy of {template}.</p>
        <label className="block">
          <span className={`${labelType} text-muted`}>Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="docs-only" className={`${field} mt-1 font-data`} />
        </label>
        {error && (
          <p role="alert" className="mt-2 text-small text-fail">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className={`${btnGhost} px-3 py-1.5`} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={btnPrimary} disabled={busy || name.trim() === ''}>
            Create workflow
          </button>
        </div>
      </form>
    </Modal>
  );
}
