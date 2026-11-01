import { useMemo, useReducer, useState } from 'react';
import { api } from '../../api';
import { toastError, toastSuccess } from '../../toast';
import { useAsyncResource } from '../../useAsyncResource';
import type { WorkflowDocument, WorkflowLibraryEntry } from '../../types';
import { btnGhost, btnPrimary, sectionTitle } from '../../ui';
import { ConfirmDialog } from '../ConfirmDialog';
import { LoadError } from '../LoadError';
import { Icon } from '../Icon';
import { downloadText } from './download';
import { YamlEditor } from './YamlEditor';
import { WorkflowBuilder } from './WorkflowBuilder';
import { WorkflowDiagram } from '../WorkflowDiagram';
import { WorkflowVariablesPanel } from './WorkflowVariablesPanel';
import { readRunsOn, readVars } from '../../workflow-yaml-vars-model';
import { readBuilder } from '../../workflow-builder-model';
import { messageParts, toEditorIssues, validateWorkflowText } from '../../workflow-editor-model';
import type { WorkflowDiagramModel } from '../../../../src/domain/workflow-diagram.js';
import { assignedChips, deleteBlock, editorReducer, editorStatus, initialEditor, issuesOf, type EditorStatusKind } from './workflows-model';

type EditorTab = 'blocks' | 'yaml' | 'variables';
const TABS: readonly { id: EditorTab; label: string }[] = [
  { id: 'blocks', label: 'Blocks' },
  { id: 'yaml', label: 'YAML' },
  { id: 'variables', label: 'Variables' },
];

const PILL_STYLES: Record<EditorStatusKind, string> = {
  saved: 'bg-merged-tint text-merged',
  edited: 'bg-raised text-muted',
  saving: 'bg-raised text-muted',
  errors: 'bg-fail-tint text-fail',
};

export function WorkflowEditor({
  entry,
  onBack,
  onChanged,
  onOpen,
}: {
  entry: WorkflowLibraryEntry;
  onBack: () => void;
  onChanged: () => void;
  onOpen: (name: string) => void;
}) {
  const doc = useAsyncResource(() => api.workflow(entry.name), [entry.name]);
  return (
    <div>
      <button type="button" onClick={onBack} className="mb-3 inline-flex min-h-11 items-center gap-1.5 font-medium text-muted hover:text-ink">
        <Icon name="arrow-left" />
        Workflows
      </button>
      {doc.error !== null && doc.data === null && <LoadError message={doc.error} onRetry={doc.reload} />}
      {doc.data === null && doc.error === null && <p className="text-muted">Loading workflow…</p>}
      {doc.data !== null && <EditorBody key={`${doc.data.name}`} entry={entry} doc={doc.data} onBack={onBack} onChanged={onChanged} onOpen={onOpen} />}
    </div>
  );
}

function EditorBody({
  entry,
  doc,
  onBack,
  onChanged,
  onOpen,
}: {
  entry: WorkflowLibraryEntry;
  doc: WorkflowDocument;
  onBack: () => void;
  onChanged: () => void;
  onOpen: (name: string) => void;
}) {
  const [state, dispatch] = useReducer(editorReducer, initialEditor(doc.text, doc.version));
  const config = useAsyncResource(() => api.config(), []);
  const modelOptions = useMemo(() => (config.data?.modelOptions ?? []).filter((o) => !o.disabled), [config.data]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [tab, setTab] = useState<EditorTab>('blocks');
  const [lastGood, setLastGood] = useState<WorkflowDiagramModel | null>(null);
  const parsed = useMemo(() => validateWorkflowText(state.text), [state.text]);
  if (parsed.diagram !== null && parsed.diagram !== lastGood) setLastGood(parsed.diagram);
  const live = { issues: parsed.issues, diagram: parsed.diagram ?? lastGood, stale: parsed.diagram === null && lastGood !== null };
  const issues = useMemo(() => [...live.issues, ...toEditorIssues(state.issues, 'server')], [live.issues, state.issues]);
  const status = editorStatus({ ...state, issues });
  const blocked = deleteBlock(entry);
  const readOnly = doc.bundled;
  const saveDisabled = readOnly || status.saveDisabled;

  const save = async () => {
    if (saveDisabled) return;
    dispatch({ type: 'saving' });
    try {
      const saved = await api.saveWorkflow(doc.name, state.text);
      dispatch({ type: 'saved', text: saved.text, version: saved.version });
      toastSuccess(`Saved ${doc.name} as v${saved.version}`);
      onChanged();
    } catch (error) {
      const issues = issuesOf(error);
      if (issues.length > 0) dispatch({ type: 'refused', issues });
      else {
        dispatch({ type: 'failed' });
        toastError(error);
      }
    }
  };

  const exportYaml = () => {
    api.exportWorkflow(doc.name).then((text) => downloadText(`${doc.name}.yaml`, text), toastError);
  };

  const duplicate = () => {
    api.duplicateWorkflow(doc.name).then((copy) => {
      onChanged();
      onOpen(copy.name);
    }, toastError);
  };

  const remove = () => {
    setConfirmingDelete(false);
    api.deleteWorkflow(doc.name).then(() => {
      toastSuccess(`Deleted ${doc.name}`);
      onChanged();
      onBack();
    }, toastError);
  };

  const treeValid = readBuilder(state.text) !== null;
  const unsaved = state.text !== state.saved;
  const varCount = readVars(state.text).length;
  const tickets = entry.inUse.tickets;

  return (
    <div className="flex flex-col gap-3.5">
      <header className="rounded-lg bg-surface shadow-card" aria-label={`Workflow ${doc.name}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3.5">
          <h2 className={sectionTitle}>{doc.name}</h2>
          <span className="font-data text-small text-muted">v{state.version}</span>
          {readOnly ? (
            <span className="rounded-sm bg-raised px-2 py-0.5 text-label font-semibold uppercase text-muted">Bundled</span>
          ) : (
            <span role="status" className={`rounded-sm px-2 py-0.5 text-small font-semibold ${PILL_STYLES[status.status]}`}>
              {status.pill}
            </span>
          )}
          <span className="flex-1" />
          <button type="button" className={btnGhost} onClick={exportYaml}>
            Export
          </button>
          <button type="button" className={readOnly ? btnPrimary : btnGhost} onClick={duplicate}>
            Duplicate
          </button>
          <button type="button" className={btnGhost} disabled={blocked !== null} title={blocked ?? undefined} onClick={() => setConfirmingDelete(true)}>
            Delete
          </button>
          <button type="button" className={`${btnPrimary} disabled:border disabled:border-hairline disabled:bg-raised disabled:bg-none disabled:text-faint disabled:opacity-100 disabled:shadow-none disabled:hover:bg-raised`} disabled={saveDisabled} onClick={save}>
            {readOnly ? 'Save' : status.saveLabel}
          </button>
        </div>
        <div className="mx-4 mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-hairline py-2.5 text-small text-muted">
          <span>
            Runs on <span className="font-data text-ink">{readRunsOn(state.text) ?? 'local'}</span>
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            Assigned as
            {assignedChips(entry).map((chip) => (
              <span key={chip.text} className="rounded-full bg-accent-tint px-2 py-0.5 text-label font-semibold text-accent">
                {chip.text}
              </span>
            ))}
          </span>
          <span>
            In use by {tickets} {tickets === 1 ? 'Ticket' : 'Tickets'} — they keep v{doc.version} until their next Retry
          </span>
        </div>
        {readOnly && (
          <div className="px-4 pb-3">
            <div className="flex flex-wrap items-center gap-2.5 rounded-sm bg-raised px-3 py-2 text-small">
              <span className="font-semibold text-ink">Read-only.</span>
              <span>Bundled workflows ship with Harmonic and are upgraded with it. Duplicate this one to edit a copy.</span>
            </div>
          </div>
        )}
        {issues.length > 0 && (
          <div className="px-4 pb-3">
            <ul aria-label="Workflow errors" className="m-0 list-none p-0 text-small text-fail">
              {issues.map((issue, i) => (
                <li key={i} className="flex gap-2 py-0.5">
                  <span className="min-w-[76px] whitespace-nowrap font-data text-label text-muted">Line {issue.line}, col {issue.column}</span>
                  <span>
                    {messageParts(issue.message).map((part, j) =>
                      part.code ? (
                        <code key={j} className="rounded-sm bg-raised px-1 font-data text-ink">
                          {part.text}
                        </code>
                      ) : (
                        part.text
                      ),
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </header>
      <div className="grid grid-cols-1 items-start gap-3.5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <section className="flex min-w-0 flex-col gap-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div role="tablist" aria-label="Editor view" className="flex gap-0.5 rounded-md bg-hairline p-[3px]">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`editor-tab-${t.id}`}
                  aria-selected={tab === t.id}
                  aria-controls="editor-tabpanel"
                  onClick={() => setTab(t.id)}
                  className={`min-h-9 rounded-sm px-3.5 text-small font-semibold ${tab === t.id ? 'bg-surface text-ink shadow-card' : 'text-ink/80 hover:text-ink'}`}
                >
                  {t.id === 'variables' ? `Variables · ${varCount}` : t.label}
                </button>
              ))}
            </div>
            <span className="flex items-center gap-1.5 text-small text-muted">
              <span className={`size-2 rounded-full ${treeValid ? 'bg-done-dot' : 'bg-fail-dot'}`} />
              {treeValid ? `Blocks and YAML in sync${unsaved ? ' · 1 unsaved change' : ''}` : 'YAML has errors; fix them to edit blocks'}
            </span>
          </div>
          <div role="tabpanel" id="editor-tabpanel" aria-labelledby={`editor-tab-${tab}`} className="rounded-lg bg-surface py-3 shadow-card">
            {tab === 'blocks' && <WorkflowBuilder text={state.text} issues={issues} readOnly={readOnly} modelOptions={modelOptions} onChange={(text) => dispatch({ type: 'edit', text })} />}
            {tab === 'yaml' && (
              <div className="px-3.5">
                <YamlEditor text={state.text} readOnly={readOnly} issues={issues} modelOptions={modelOptions} onChange={(text) => dispatch({ type: 'edit', text })} onSave={save} />
                <p className="pt-2 text-small text-muted">
                  Completion offers Workflow Actions after <code className="font-data">uses:</code> and step keys on a new line. Errors show inline with line and column; Save stays disabled until they&apos;re fixed.
                </p>
              </div>
            )}
            {tab === 'variables' && <WorkflowVariablesPanel name={doc.name} text={state.text} readOnly={readOnly} onChange={(text) => dispatch({ type: 'edit', text })} />}
          </div>
        </section>
        <div className="min-w-0 xl:sticky xl:top-4">
          <WorkflowDiagram model={live.diagram} stale={live.stale} errorCount={issues.length} />
        </div>
      </div>
      <p className="text-small text-muted">Edits apply from the Ticket&apos;s next Retry; in-flight Tickets finish on the version they snapshotted.</p>
      {confirmingDelete && (
        <ConfirmDialog label={`Delete ${doc.name}`} title={`Delete “${doc.name}”?`} confirmLabel="Delete workflow" tone="danger" onConfirm={remove} onCancel={() => setConfirmingDelete(false)}>
          Deleting removes its YAML file from the data directory and cannot be undone.
        </ConfirmDialog>
      )}
    </div>
  );
}
