import { useEffect, useState } from 'react';
import { renderMarkdown } from '../markdown';

/**
 * Rendered, sanitized Markdown for tracker-issue descriptions. Styling of the
 * emitted tags lives in index.css under `.markdown`. Shown in Task detail (the
 * board card stays brief — a clamped title only).
 *
 * `renderMarkdown` dynamically imports `marked`, so the render resolves a tick
 * later on first use; the raw source is shown until the HTML is ready.
 */
export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setHtml(null);
    renderMarkdown(source).then((rendered) => {
      if (alive) setHtml(rendered);
    });
    return () => {
      alive = false;
    };
  }, [source]);

  if (html === null) return <div className={`markdown ${className}`}>{source}</div>;
  return (
    <div className={`markdown ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
