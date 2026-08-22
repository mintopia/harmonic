import { useSyncExternalStore } from 'react';
import { Icon } from './components/Icon';
import { landOutcomeBanner, type EpicLandOutcome } from './epic-model';

/**
 * The designed notice surface: operations announce in a top-right stack of
 * cards, not a native alert() that breaks the register (DESIGN.md § Elevation).
 * Two kinds share the stack — `error`, fail-tinted, for a rejected operation;
 * `success`, a quiet neutral acknowledgement, for a completed gate action
 * (accept/reject/cancel — issue #98) that would otherwise leave nothing on
 * screen to say it worked. Success stays neutral, not accept-green: green means
 * a *completed* state in this palette, and an acknowledgement is not a state
 * (the same reasoning that keeps the review gate's Accept off state colour).
 * A module-level store (like ws.ts) so any handler can call it without
 * threading context.
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
  setTimeout(() => dismissToast(id), 6000);
}

/** Surface a rejected operation. Auto-dismisses after 6s; the operator can
 * also close it. Accepts unknown so promise catch handlers pass errors raw. */
export function toastError(e: unknown) {
  push(e instanceof Error ? e.message : String(e), 'error');
}

/** Acknowledge a completed gate action (accept/reject/cancel — issue #98):
 * a short, neutral notice naming what happened, so a successful destructive
 * or irreversible action never lands silently. Auto-dismisses after 6s. */
export function toastSuccess(message: string) {
  push(message, 'success');
}

/** Surface a force-land outcome (issue #167, ADR-0026): maps the outcome's
 * banner tone to a toast kind — `ok` acknowledges success, everything else
 * (`warn`/`bad`/`info`) reads as a rejection so the operator notices it.
 * Shared by Board's focus-mode header and the Table's band headers, which
 * otherwise repeated this mapping verbatim. */
export function toastLandOutcome(outcome: EpicLandOutcome): void {
  const banner = landOutcomeBanner(outcome);
  if (banner.tone === 'ok') toastSuccess(banner.text);
  else toastError(banner.text);
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
        {items.map((t) => {
          // Error keeps the fail vocabulary; success is a quiet neutral card
          // (raised fill, ink text) with a check — an acknowledgement, not a
          // state colour (issue #98).
          const success = t.kind === 'success';
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-2.5 rounded-lg px-3.5 py-2.5 shadow-bar motion-safe:animate-[toast-in_150ms_var(--ease-out-quint)] ${
                success ? 'bg-raised text-ink' : 'bg-fail-tint text-fail'
              }`}
            >
              {success && <Icon name="check" className="mt-0.5 shrink-0 text-muted" />}
              <span className="min-w-0 flex-1 break-words">{t.message}</span>
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

/** Collapse consecutive toasts carrying the same message into one. */
export function dedupeToasts<T extends { message: string }>(toasts: readonly T[]): T[] {
  const out: T[] = [];
  for (const t of toasts) {
    const last = out[out.length - 1];
    if (last && last.message === t.message) continue;
    out.push(t);
  }
  return out;
}
