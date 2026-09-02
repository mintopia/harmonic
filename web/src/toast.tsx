import { useSyncExternalStore } from 'react';
import { Icon } from './components/Icon';

type ToastKind = 'error' | 'success';
type Toast = { id: number; message: string; kind: ToastKind };

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

function push(message: string, kind: ToastKind) {
  const id = ++seq;
  toasts = [...toasts, { id, message, kind }];
  emit();
  if (kind === 'success') setTimeout(() => dismissToast(id), 6000);
}

/** Surface a rejected operation. Stays until the operator dismisses it, so a
 * long message is readable. Accepts unknown so promise catch handlers pass
 * errors raw. */
export function toastError(e: unknown) {
  push(e instanceof Error ? e.message : String(e), 'error');
}

/** Acknowledge a completed gate action (accept/reject/cancel):
 * a short, neutral notice naming what happened, so a successful destructive
 * or irreversible action never merges silently. Auto-dismisses after 6s. */
export function toastSuccess(message: string) {
  push(message, 'success');
}

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
    <div aria-label="Notifications" aria-live="assertive" className="pointer-events-none relative z-50 h-0">
      <div className="absolute right-4 top-4 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 transition-[right] duration-150 ease-out motion-reduce:transition-none min-[1080px]:group-has-[[data-dock=docked]]/shell:right-[27.5rem]">
        {items.map((t) => {
          const success = t.kind === 'success';
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-2.5 rounded-lg px-3.5 py-2.5 shadow-bar motion-safe:animate-[toast-in_150ms_var(--ease-out-quint)] ${
                success ? 'bg-raised text-ink' : 'bg-fail-tint text-fail'
              }`}
            >
              {success && <Icon name="check" className="mt-0.5 shrink-0 text-muted" />}
              <span
                className={`min-w-0 flex-1 break-words ${
                  success ? '' : 'max-h-[60vh] overflow-y-auto whitespace-pre-wrap'
                }`}
              >
                {t.message}
              </span>
              <button
                aria-label="Dismiss"
                className={`-mr-2 -mt-2 inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md transition-opacity duration-150 hover:opacity-70 ${
                  success ? 'text-muted' : 'text-fail'
                }`}
                onClick={() => dismissToast(t.id)}
              >
                <Icon name="close" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

