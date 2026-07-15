import { useSyncExternalStore } from 'react';
import { Icon } from './components/Icon';

/**
 * The designed error surface: failed operations announce in a bottom-right
 * stack of fail-tinted cards, not a native alert() that breaks the register
 * (DESIGN.md § Elevation — the fail vocabulary). A module-level store (like
 * ws.ts) so any handler can call toastError() without threading context.
 */
type Toast = { id: number; message: string };

let toasts: Toast[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function emit() {
  for (const listener of listeners) listener();
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** Surface a rejected operation. Auto-dismisses after 6s; the operator can
 * also close it. Accepts unknown so promise catch handlers pass errors raw. */
export function toastError(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  const id = ++seq;
  toasts = [...toasts, { id, message }];
  emit();
  setTimeout(() => dismissToast(id), 6000);
}

/** Mounted once by App. */
export function Toaster() {
  const items = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => toasts,
  );
  if (items.length === 0) return null;
  return (
    <div
      aria-label="Notifications"
      aria-live="assertive"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-start gap-2.5 rounded-lg bg-fail-tint px-3.5 py-2.5 text-fail shadow-bar motion-safe:animate-[toast-in_150ms_var(--ease-ledger)]"
        >
          <span className="min-w-0 flex-1 break-words">{t.message}</span>
          <button
            aria-label="Dismiss"
            className="shrink-0 rounded-md p-0.5 text-fail transition-opacity duration-150 hover:opacity-70"
            onClick={() => dismissToast(t.id)}
          >
            <Icon name="close" />
          </button>
        </div>
      ))}
    </div>
  );
}
