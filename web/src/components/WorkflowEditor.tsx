import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { minimalSetup } from 'codemirror';
import { acceptCompletion, autocompletion, completionKeymap, type CompletionContext } from '@codemirror/autocomplete';
import { forceLinting, linter, type Diagnostic } from '@codemirror/lint';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { yaml } from '@codemirror/lang-yaml';
import { tags as t } from '@lezer/highlight';
import { completeWorkflow } from '../../../src/domain/workflow-completion.js';
import type { WorkflowDiagramModel } from '../../../src/domain/workflow-diagram.js';
import { serverRefusalIssues, validateWorkflowText, type WorkflowEditorIssue } from '../workflow-editor-model.js';
import { btnGhost, btnPrimary } from '../ui';
import { WorkflowDiagram } from './WorkflowDiagram';

const theme = EditorView.theme({
  '&': { color: 'var(--hm-ink)', backgroundColor: 'var(--hm-field)', minHeight: '360px' },
  '.cm-content': { caretColor: 'var(--hm-accent)', fontFamily: 'var(--font-data)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--hm-faint)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--hm-ink) 5%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-tooltip': { backgroundColor: 'var(--hm-surface)', border: '1px solid var(--hm-edge)', color: 'var(--hm-ink)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--hm-accent-tint)', color: 'var(--hm-ink)' },
  '.cm-completionDetail': { color: 'var(--hm-muted)', fontStyle: 'normal', marginLeft: '1em' },
  '.cm-tooltip-autocomplete::after': { content: '"Closed set of Workflow Actions · Tab to accept"', display: 'block', padding: '3px 8px', fontSize: '11px', color: 'var(--hm-faint)', borderTop: '1px solid var(--hm-hairline)' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--hm-fail)', textUnderlineOffset: '3px' },
});

const highlight = HighlightStyle.define([
  { tag: t.comment, color: 'var(--hm-syntax-comment)', fontStyle: 'italic' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--hm-syntax-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--hm-syntax-string)' },
  { tag: [t.number, t.bool, t.atom, t.null], color: 'var(--hm-ready)' },
  { tag: [t.meta, t.punctuation, t.separator], color: 'var(--hm-faint)' },
]);

const completionSource = (ctx: CompletionContext) => {
  const hit = completeWorkflow(ctx.state.doc.toString(), ctx.pos);
  if (!hit) return null;
  return { from: hit.from, options: hit.options.map((o) => ({ label: o.label, detail: o.detail, type: 'keyword' })), validFor: /^[\w-]*$/ };
};

function toDiagnostics(view: EditorView, issues: readonly WorkflowEditorIssue[]): Diagnostic[] {
  const doc = view.state.doc;
  return issues.map((issue) => {
    const line = doc.line(Math.min(Math.max(issue.line, 1), doc.lines));
    const from = Math.min(line.from + Math.max(issue.column - 1, 0), line.to);
    const word = /^[\w-]+/.exec(doc.sliceString(from, line.to));
    const to = word ? from + word[0].length : Math.max(from + 1, Math.min(line.to, from + 1));
    return { from, to: Math.min(to, doc.length), severity: 'error', message: issue.message, source: issue.source === 'server' ? 'SERVER' : 'SCHEMA' };
  });
}

export interface WorkflowEditorProps {
  name: string;
  version: number;
  bundled: boolean;
  initialText: string;
  onSave: (text: string) => Promise<void>;
  onExport: () => void;
  onDuplicate: () => void;
  onDelete?: () => void;
}

export function WorkflowEditor({ name, version, bundled, initialText, onSave, onExport, onDuplicate, onDelete }: WorkflowEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const diagramRef = useRef<WorkflowDiagramModel | null>(null);
  const serverRef = useRef<WorkflowEditorIssue[]>([]);
  const textRef = useRef(initialText);
  const [text, setText] = useState(initialText);
  const [savedText, setSavedText] = useState(initialText);
  const [schemaIssues, setSchemaIssues] = useState<WorkflowEditorIssue[]>([]);
  const [serverIssues, setServerIssues] = useState<WorkflowEditorIssue[]>([]);
  const [diagram, setDiagram] = useState<WorkflowDiagramModel | null>(null);
  const [stale, setStale] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    const source = (v: EditorView): Diagnostic[] => {
      const result = validateWorkflowText(v.state.doc.toString(), diagramRef.current);
      diagramRef.current = result.diagram;
      setSchemaIssues(result.issues);
      setDiagram(result.diagram);
      setStale(result.stale);
      return toDiagnostics(v, [...result.issues, ...serverRef.current]);
    };
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: textRef.current,
        extensions: [
          minimalSetup,
          lineNumbers(),
          highlightActiveLine(),
          yaml(),
          syntaxHighlighting(highlight),
          theme,
          autocompletion({ override: [completionSource] }),
          keymap.of([{ key: 'Tab', run: acceptCompletion }, ...completionKeymap]),
          linter(source, { delay: 150 }),
          EditorState.readOnly.of(bundled),
          EditorView.editable.of(!bundled),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            textRef.current = update.state.doc.toString();
            serverRef.current = [];
            setServerIssues([]);
            setText(textRef.current);
          }),
        ],
      }),
    });
    view.current = created;
    return () => { created.destroy(); view.current = null; };
  }, [bundled]);

  const issues = [...schemaIssues, ...serverIssues];
  const dirty = text !== savedText;

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(textRef.current);
      setSavedText(textRef.current);
    } catch (error) {
      const found = serverRefusalIssues(error instanceof Error ? error : { message: 'Save failed' });
      serverRef.current = found;
      setServerIssues(found);
      if (view.current) forceLinting(view.current);
    } finally {
      setSaving(false);
    }
  }, [onSave]);

  const pill = issues.length ? { label: `${issues.length} ${issues.length === 1 ? 'error' : 'errors'}`, cls: 'bg-fail-tint text-fail' } : dirty ? { label: 'Unsaved', cls: 'bg-running-tint text-running' } : { label: 'Saved', cls: 'bg-done-tint text-done' };

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <section className="min-w-0 rounded border border-hairline bg-surface pb-3" aria-label={`Workflow ${name}`}>
        <header className="flex flex-wrap items-center gap-2 px-3.5 py-3">
          <h3 className="text-body font-semibold text-ink">{name}</h3>
          <span className="font-data text-small text-muted">v{version}</span>
          <span className={`rounded-full px-2 py-0.5 text-small font-medium ${pill.cls}`} data-testid="workflow-status">{pill.label}</span>
          <span className="flex-1" />
          <button type="button" className={btnGhost} onClick={onExport}>Export</button>
          <button type="button" className={btnGhost} onClick={onDuplicate}>Duplicate</button>
          {onDelete && <button type="button" className={btnGhost} onClick={onDelete}>Delete</button>}
          {!bundled && (
            <button type="button" className={btnPrimary} disabled={issues.length > 0 || !dirty || saving} onClick={() => void save()}>
              {issues.length ? `Save · ${issues.length} ${issues.length === 1 ? 'error' : 'errors'}` : 'Save'}
            </button>
          )}
        </header>
        {issues.length > 0 && (
          <ul className="mx-3.5 mb-2 space-y-1" aria-label="Workflow errors">
            {issues.map((issue, i) => (
              <li key={`${issue.line}:${issue.column}:${i}`} className="flex items-baseline gap-2 text-small text-fail" data-testid="workflow-error">
                <span className="font-data">Line {issue.line}, col {issue.column}</span>
                <span>{issue.message}</span>
                <span className="font-data text-faint">{issue.source === 'server' ? 'SERVER' : 'SCHEMA'}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mx-3.5 overflow-auto rounded border border-hairline font-code text-small" role="textbox" aria-label="Workflow YAML" ref={host} />
        <p className="mx-3.5 mt-2 text-small text-muted">{bundled ? 'Bundled workflows are read-only; duplicate one to edit it. ' : ''}Edits apply from the Ticket's next Retry; in-flight Tickets finish on the version they snapshotted.</p>
      </section>
      <WorkflowDiagram model={diagram} stale={stale} errorCount={issues.length} />
    </div>
  );
}
