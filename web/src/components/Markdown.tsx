import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { renderMarkdown } from '../markdown';
import { useLiveEffect } from '../useLiveEffect';

/** Give every fenced code block a hover copy button. Idempotent: the button is
 * rebuilt after each render (the HTML is replaced wholesale as a message
 * streams), and clicks are handled by delegation on the container, so no
 * per-button listener leaks. */
function decorateCodeBlocks(root: HTMLElement): void {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.querySelector('.md-copy')) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'md-copy';
    button.dataset.copy = '';
    button.setAttribute('aria-label', 'Copy code');
    button.textContent = 'Copy';
    pre.appendChild(button);
  }
}

async function copyFrom(button: HTMLElement): Promise<void> {
  const pre = button.closest('pre');
  const code = pre?.querySelector('code')?.textContent ?? pre?.textContent ?? '';
  try {
    await navigator.clipboard.writeText(code.replace(/\n$/, ''));
    const prev = button.textContent;
    button.textContent = 'Copied';
    button.classList.add('is-copied');
    setTimeout(() => {
      button.textContent = prev;
      button.classList.remove('is-copied');
    }, 1200);
  } catch {
    // Clipboard blocked (insecure context / denied) — leave the button as-is.
  }
}

/**
 * `renderMarkdown` dynamically imports `marked`, so the render resolves a tick
 * later on first use; the raw source is shown until the HTML is ready. Each
 * fenced code block gets a hover copy button.
 */
export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useLiveEffect((live) => {
    setHtml(null);
    renderMarkdown(source).then((rendered) => {
      if (live()) setHtml(rendered);
    });
  }, [source]);

  useEffect(() => {
    if (ref.current) decorateCodeBlocks(ref.current);
  }, [html]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-copy]');
    if (button) void copyFrom(button);
  };

  if (html === null) return <div ref={ref} className={`markdown ${className}`}>{source}</div>;
  return (
    <div
      ref={ref}
      className={`markdown ${className}`}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
