import { useSyncExternalStore } from 'react';
import { Icon } from './components/Icon';

/**
 * The designed error surface: failed operations announce in a top-right
 * stack of fail-tinted cards, not a native alert() that breaks the register
 * (DESIGN.md § Elevation — the fail vocabulary). A module-level store (like
 * ws.ts) so any handler can call toastError() without threading context.
 *
 * App mounts this directly under the <header>, and the stack hangs off a
 * zero-height anchor rather than a `fixed` offset: the header wraps (and so
 * changes height) at narrow widths, so any hardcoded top inset would be
 * wrong at some viewport. Zero height keeps the anchor out of the flow —
 * toasts never push the view down — while still pinning them to the header's
 * bottom edge. The anchor used to be `sticky top-0`, to survive the header
 * scrolling away; the shell now pins the header and scrolls only the working
 * view (App.tsx), so there is nothing left to stick to.
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
    <div aria-label="Notifications" aria-live="assertive" className="pointer-events-none relative z-50 h-0">
      {/* The stack dodges an open Conversation dock rather than land on its
          title row and its one primary action. `27.5rem` clears the dock
          (1rem inset + 26rem wide) with a 0.5rem gap. Gated at 1080px because
          below that there is nowhere to dodge *to*: the stack is 24rem, so it
          needs 51.5rem of right-hand room, and under ~1080px that would put it
          under the sidebar — worse than the overlap. There the toast simply
          wins on z-index for its ~6s, as it always did on short viewports. */}
      <div className="absolute right-4 top-4 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 transition-[right] duration-150 ease-out motion-reduce:transition-none min-[1080px]:group-has-[[data-dock=docked]]/shell:right-[27.5rem]">
        {items.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-2.5 rounded-lg bg-fail-tint px-3.5 py-2.5 text-fail shadow-bar motion-safe:animate-[toast-in_150ms_var(--ease-out-quint)]"
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
    </div>
  );
}

/** Collapse consecutive toasts carrying the same message into one. */
export function dedupeToasts<T extends { message: string }>(toasts: readonly T[]): T[] {
  const out: T[] = [];
  for (const t of toasts) {
    if (out.length && out[out.length - 1].message === t.message) continue;
    out.push(t);
  }
  return out;
}
