import { useEffect, useRef, useState } from 'react';
import { copyText, type CopySource } from '../clipboard';
import { touchOverlay } from '../ui';
import { Icon } from './Icon';

/** Quiet until the enclosing `group` is hovered or the button is focused; always shown on touch. */
export const revealOnHover = 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100';

const CONFIRM_MS = 1200;

/** Copy to the clipboard and expose a brief `copied` confirmation; the timer is cleared on unmount. */
export function useCopyConfirmation(): { copied: boolean; copy: (source: CopySource) => Promise<void> } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async (source: CopySource) => {
    if (!(await copyText(source))) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
  };
  return { copied, copy };
}

export function CopyButton({
  text,
  label,
  variant = 'icon',
  className = '',
}: {
  text: CopySource;
  label: string;
  variant?: 'icon' | 'text';
  className?: string;
}) {
  const { copied, copy: copySource } = useCopyConfirmation();
  const copy = () => copySource(text);
  return (
    <>
      {variant === 'icon' ? (
        <button
          type="button"
          aria-label={label}
          onClick={copy}
          className={`relative inline-grid size-6 shrink-0 place-items-center rounded text-muted transition-[color,opacity] duration-150 hover:text-ink ${copied ? '!text-merged !opacity-100' : ''} ${className}`}
        >
          <span aria-hidden="true" className={touchOverlay} />
          <Icon name={copied ? 'check' : 'copy'} className="size-3.5" />
        </button>
      ) : (
        <button
          type="button"
          aria-label={label}
          onClick={copy}
          className={`inline-flex min-h-11 shrink-0 items-center font-medium text-muted transition-colors duration-150 hover:text-ink ${className}`}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
      <span role="status" className="sr-only">
        {copied ? 'Copied' : ''}
      </span>
    </>
  );
}
