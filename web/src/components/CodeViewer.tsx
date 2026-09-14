import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

export function CodeViewer({ path, text, onChange, onSave }: { path: string; text: string; onChange: (text: string) => void; onSave: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const textRef = useRef(text);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);

  useEffect(() => { textRef.current = text; }, [text]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    const language = LanguageDescription.matchFilename(languages, path);
    const make = async () => {
      const extensions = [
        basicSetup,
        EditorView.lineWrapping,
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
      if (language) extensions.push((await language.load()).extension);
      if (disposed || !host.current) return;
      view.current = new EditorView({ state: EditorState.create({ doc: textRef.current, extensions }), parent: host.current });
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
