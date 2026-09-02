import { useState } from 'react';
import { renderMarkdown } from '../markdown';
import { useLiveEffect } from '../useLiveEffect';

/**
 * `renderMarkdown` dynamically imports `marked`, so the render resolves a tick
 * later on first use; the raw source is shown until the HTML is ready.
 */
export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useLiveEffect((live) => {
    setHtml(null);
    renderMarkdown(source).then((rendered) => {
      if (live()) setHtml(rendered);
    });
  }, [source]);

  if (html === null) return <div className={`markdown ${className}`}>{source}</div>;
  return (
    <div className={`markdown ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
