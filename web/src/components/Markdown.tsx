import { renderMarkdown } from '../markdown';

/**
 * Rendered, sanitized Markdown for tracker-issue descriptions. Styling of the
 * emitted tags lives in index.css under `.markdown`. Shown in Task detail (the
 * board card stays brief — a clamped title only).
 */
export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  return (
    <div className={`markdown ${className}`} dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} />
  );
}
