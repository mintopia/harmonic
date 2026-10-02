import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useCopyConfirmation } from './CopyButton';
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

function codeOf(button: HTMLElement): string {
  const pre = button.closest('pre');
  const code = pre?.querySelector('code')?.textContent ?? pre?.textContent ?? '';
  return code.replace(/\n$/, '');
}

/**
 * `renderMarkdown` dynamically imports `marked`, so the render resolves a tick
 * later on first use; the raw source is shown until the HTML is ready. Each
 * fenced code block gets a hover copy button.
 */
const isExternalHref = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#');

export function Markdown({ source, className = '', onFileLink }: { source: string; className?: string; onFileLink?: (href: string) => void }) {
  const [html, setHtml] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const copiedButton = useRef<HTMLElement | null>(null);
  const { copied, copy } = useCopyConfirmation();

  useLiveEffect((live) => {
    setHtml(null);
    renderMarkdown(source).then((rendered) => {
      if (live()) setHtml(rendered);
    });
  }, [source]);

  useEffect(() => {
    if (ref.current) decorateCodeBlocks(ref.current);
  }, [html]);

  useEffect(() => {
    const button = copiedButton.current;
    if (!copied || !button) return;
    button.textContent = 'Copied';
    button.classList.add('is-copied');
    return () => {
      button.textContent = 'Copy';
      button.classList.remove('is-copied');
    };
  }, [copied]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>('[data-copy]');
    if (button) { copiedButton.current = button; void copy(codeOf(button)); return; }
    if (onFileLink) {
      const anchor = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
      const href = anchor?.getAttribute('href');
      if (anchor && href && !isExternalHref(href)) {
        e.preventDefault();
        onFileLink(href);
      }
    }
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
