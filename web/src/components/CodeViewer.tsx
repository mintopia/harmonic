import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags as t } from '@lezer/highlight';

// Colours resolve to the app's --hm-* tokens, so the editor tracks the active
// theme without rebuilding — the reason line numbers and syntax stay legible in
// both light and dark.
const paperTheme = EditorView.theme({
  '&': { color: 'var(--hm-ink)', backgroundColor: 'transparent' },
  '.cm-content': { caretColor: 'var(--hm-accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--hm-accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--hm-accent-tint)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--hm-faint)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--hm-ink) 5%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--hm-muted)' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--hm-accent) 18%, transparent)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--hm-raised)', color: 'var(--hm-muted)', border: 'none' },
});

const paperHighlight = HighlightStyle.define([
  { tag: t.comment, color: 'var(--hm-syntax-comment)', fontStyle: 'italic' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.moduleKeyword, t.definitionKeyword], color: 'var(--hm-syntax-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--hm-syntax-string)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.className, t.typeName, t.tagName, t.heading, t.attributeName], color: 'var(--hm-syntax-title)' },
  { tag: [t.number, t.bool, t.atom, t.null, t.constant(t.variableName)], color: 'var(--hm-ready)' },
  { tag: [t.meta, t.punctuation, t.separator, t.bracket], color: 'var(--hm-faint)' },
  { tag: t.invalid, color: 'var(--hm-fail)' },
]);

export type CursorInfo = { line: number; col: number; selection: number };

export function CodeViewer({ path, text, onChange, onSave, onCursor }: { path: string; text: string; onChange: (text: string) => void; onSave: () => void; onCursor?: (info: CursorInfo) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const textRef = useRef(text);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  const onCursorRef = useRef(onCursor);

  useEffect(() => { textRef.current = text; }, [text]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);
  useEffect(() => { onCursorRef.current = onCursor; }, [onCursor]);

  const reportCursor = (target: EditorView) => {
    const sel = target.state.selection.main;
    const line = target.state.doc.lineAt(sel.head);
    const selection = target.state.selection.ranges.reduce((sum, range) => sum + (range.to - range.from), 0);
    onCursorRef.current?.({ line: line.number, col: sel.head - line.from + 1, selection });
  };

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    const language = LanguageDescription.matchFilename(languages, path);
    const make = async () => {
      const extensions = [
        syntaxHighlighting(paperHighlight),
        basicSetup,
        paperTheme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          if (update.docChanged || update.selectionSet) reportCursor(update.view);
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
      if (language) extensions.push((await language.load()).extension);
      if (disposed || !host.current) return;
      view.current = new EditorView({ state: EditorState.create({ doc: textRef.current, extensions }), parent: host.current });
      reportCursor(view.current);
    };
    void make();
    return () => { disposed = true; view.current?.destroy(); view.current = null; };
  }, [path]);

  useEffect(() => {
    const current = view.current;
    if (!current || current.state.doc.toString() === text) return;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: text } });
  }, [text]);

  return <div aria-label={`Editing file ${path}`} className="min-h-0 flex-1 overflow-auto font-code text-small [&_.cm-editor]:min-h-full [&_.cm-scroller]:font-code" ref={host} />;
}
