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
import { WorkflowDiagram } from '../WorkflowDiagram';
import { messageParts, toEditorIssues, validateWorkflowText } from '../../workflow-editor-model';
import type { WorkflowDiagramModel } from '../../../../src/domain/workflow-diagram.js';
import { deleteBlock, editorReducer, editorStatus, initialEditor, issuesOf, type EditorStatusKind } from './workflows-model';

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
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(360px,1fr)_minmax(0,1.5fr)]">
    <section className="min-w-0 rounded-lg bg-surface pb-3 shadow-card" aria-label={`Workflow ${doc.name}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-3">
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
      {readOnly && (
        <div className="px-3.5 pb-2">
          <div className="flex flex-wrap items-center gap-2.5 rounded-sm bg-raised px-3 py-2 text-small">
            <span className="font-semibold text-ink">Read-only.</span>
            <span>Bundled workflows ship with Harmonic and are upgraded with it. Duplicate this one to edit a copy.</span>
          </div>
        </div>
      )}
      {issues.length > 0 && (
        <div className="px-3.5 pb-2">
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
      <div className="px-3.5">
        <YamlEditor text={state.text} readOnly={readOnly} issues={issues} onChange={(text) => dispatch({ type: 'edit', text })} onSave={save} />
      </div>
      <p className="px-3.5 pt-2 text-small text-faint">Edits apply from the Ticket&apos;s next Retry; in-flight Tickets finish on the version they snapshotted.</p>
      {confirmingDelete && (
        <ConfirmDialog label={`Delete ${doc.name}`} title={`Delete “${doc.name}”?`} confirmLabel="Delete workflow" tone="danger" onConfirm={remove} onCancel={() => setConfirmingDelete(false)}>
          Deleting removes its YAML file from the data directory and cannot be undone.
        </ConfirmDialog>
      )}
    </section>
    <WorkflowDiagram model={live.diagram} stale={live.stale} errorCount={issues.length} />
    </div>
  );
}
