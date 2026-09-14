import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

export function CodeViewer({ path, text }: { path: string; text: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let view: EditorView | null = null;
    const language = LanguageDescription.matchFilename(languages, path);
    const make = async () => {
      const extensions = [basicSetup, EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping];
      if (language) extensions.push((await language.load()).extension);
      if (disposed || !host.current) return;
      view = new EditorView({ state: EditorState.create({ doc: text, extensions }), parent: host.current });
    };
    void make();
    return () => { disposed = true; view?.destroy(); };
  }, [path, text]);

  return <div aria-label={`Read-only file ${path}`} className="min-h-0 flex-1 overflow-auto font-code text-small [&_.cm-editor]:min-h-full [&_.cm-scroller]:font-code" ref={host} />;
}
