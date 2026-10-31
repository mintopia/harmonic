import { useEffect, useRef } from 'react';
import { Compartment, EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { acceptCompletion, type CompletionContext } from '@codemirror/autocomplete';
import { keymap } from '@codemirror/view';
import { completeWorkflow } from '../../../../src/domain/workflow-completion.js';
import { LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import type { WorkflowIssue } from '../../types';
import { messageParts } from '../../workflow-editor-model';
import { paperHighlight, paperTheme } from '../CodeViewer';

class IssueWidget extends WidgetType {
  constructor(private readonly issue: WorkflowIssue) {
    super();
  }
  eq(other: IssueWidget) {
    return other.issue.line === this.issue.line && other.issue.column === this.issue.column && other.issue.message === this.issue.message;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-issue-message';
    el.setAttribute('role', 'alert');
    el.dataset.line = String(this.issue.line);
    el.dataset.column = String(this.issue.column);
    el.append(`Line ${this.issue.line}, col ${this.issue.column}: `);
    for (const part of messageParts(this.issue.message)) {
      if (!part.code) el.append(part.text);
      else {
        const chip = document.createElement('code');
        chip.className = 'cm-issue-chip';
        chip.textContent = part.text;
        el.append(chip);
      }
    }
    return el;
  }
}

const completionSource = (ctx: CompletionContext) => {
  const hit = completeWorkflow(ctx.state.doc.toString(), ctx.pos);
  if (!hit) return null;
  return { from: hit.from, options: hit.options.map((o) => ({ label: o.label, detail: o.detail, type: 'keyword' })), validFor: /^[\w-]*$/ };
};

const setIssues = StateEffect.define<readonly WorkflowIssue[]>();

function buildDecorations(state: EditorState, issues: readonly WorkflowIssue[]): DecorationSet {
  const ranges = [];
  for (const issue of issues) {
    const line = state.doc.line(Math.min(Math.max(issue.line, 1), state.doc.lines));
    const from = Math.min(line.from + Math.max(issue.column - 1, 0), line.to);
    ranges.push(Decoration.line({ class: 'cm-issue-line', attributes: { 'data-issue-line': String(issue.line) } }).range(line.from));
    if (from < line.to) {
      const rest = line.text.slice(from - line.from);
      const word = /^[\w.-]+/.exec(rest)?.[0].length ?? 1;
      ranges.push(Decoration.mark({ class: 'cm-issue-mark' }).range(from, Math.min(from + word, line.to)));
    }
    ranges.push(Decoration.widget({ widget: new IssueWidget(issue), block: true, side: 1 }).range(line.to));
  }
  return Decoration.set(ranges, true);
}

const issueField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setIssues)) return buildDecorations(tr.state, effect.value);
    return tr.docChanged ? Decoration.none : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const issueTheme = EditorView.theme({
  '.cm-issue-line': { backgroundColor: 'var(--hm-fail-tint)' },
  '.cm-issue-mark': { textDecoration: 'underline wavy var(--hm-fail)' },
  '.cm-issue-chip': { fontFamily: 'var(--font-code, monospace)', background: 'var(--hm-surface)', padding: '0 4px', borderRadius: '3px' },
  '.cm-issue-message': { backgroundColor: 'var(--hm-fail-tint)', color: 'var(--hm-fail)', padding: '3px 12px 4px', fontFamily: 'var(--font-sans, inherit)', fontSize: '12px' },
  '&': { backgroundColor: 'transparent' },
  '.cm-completionIcon': { display: 'none' },
  '.cm-tooltip-autocomplete::after': { content: '"Closed set of Workflow Actions · Tab to accept"', display: 'block', padding: '3px 8px', fontSize: '11px', color: 'var(--hm-faint)', borderTop: '1px solid var(--hm-hairline)' },
});

export function YamlEditor({
  text,
  readOnly,
  issues,
  onChange,
  onSave,
}: {
  text: string;
  readOnly: boolean;
  issues: readonly WorkflowIssue[];
  onChange: (text: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const textRef = useRef(text);
  const issuesRef = useRef(issues);
  useEffect(() => {
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    textRef.current = text;
    issuesRef.current = issues;
  });

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    const language = new Compartment();
    const extensions: Extension[] = [
      syntaxHighlighting(paperHighlight),
      basicSetup,
      paperTheme,
      issueTheme,
      issueField,
      language.of([]),
      EditorState.languageData.of(() => [{ autocomplete: completionSource }]),
      keymap.of([{ key: 'Tab', run: acceptCompletion }]),
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      EditorView.contentAttributes.of({ 'aria-label': 'Workflow YAML' }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString());
      }),
      EditorView.domEventHandlers({
        keydown: (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            onSaveRef.current();
            return true;
          }
          return false;
        },
      }),
    ];
    const created = new EditorView({ state: EditorState.create({ doc: textRef.current, extensions }), parent: host.current });
    view.current = created;
    if (issuesRef.current.length > 0) created.dispatch({ effects: setIssues.of(issuesRef.current) });
    const description = LanguageDescription.matchFilename(languages, 'workflow.yaml');
    void description?.load().then((support) => {
      if (!disposed) created.dispatch({ effects: language.reconfigure(support.extension) });
    }, () => {});
    return () => {
      disposed = true;
      created.destroy();
      view.current = null;
    };
  }, [readOnly]);

  useEffect(() => {
    const current = view.current;
    if (!current || current.state.doc.toString() === text) return;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: text } });
  }, [text]);

  useEffect(() => {
    view.current?.dispatch({ effects: setIssues.of(issues) });
  }, [issues]);

  return (
    <div
      ref={host}
      data-testid="workflow-yaml"
      className={`overflow-auto rounded-sm border border-edge font-code text-small [&_.cm-editor]:min-h-[20rem] [&_.cm-scroller]:font-code ${readOnly ? 'bg-sunken' : 'bg-field'}`}
    />
  );
}
