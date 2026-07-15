import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Native <dialog> modal: focus trapping, Escape-to-close, top-layer stacking
 * and focus restore all come from the platform. Clicking the backdrop closes.
 * Keep the dialog itself padding-free so backdrop-click detection (target ===
 * dialog) never fires from clicks inside the panel; children own their padding.
 * Separation from the page is the floating-bar shadow plus the backdrop dim
 * (in dark the shadow token carries a hairline ring, since shadows vanish
 * on a dark field — the Soft Depth Rule).
 */
export function Modal({
  label,
  onClose,
  className = '',
  children,
}: {
  label: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement;
    // The open guard makes StrictMode's double effect invocation a no-op.
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      // The platform only restores focus through dialog.close(); most close
      // paths here unmount on state change instead, so restore it by hand.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current.close();
      }}
      className={`m-auto w-[calc(100%-2rem)] rounded-xl bg-surface p-0 text-ink shadow-bar ${className}`}
    >
      {children}
    </dialog>
  );
}
