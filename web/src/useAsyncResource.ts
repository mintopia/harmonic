import { useCallback, useLayoutEffect, useRef, useState, type DependencyList } from 'react';
import { useLiveEffect } from './useLiveEffect';

export type AsyncResource<T> = {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Loads `load()` on mount, on every `deps` change, and (if `options.pollMs` is set) on that
 * interval after each settle — a run of failures backs that interval off exponentially (capped),
 * resetting to `pollMs` on the next success or an explicit `reload`, so a down endpoint is not
 * polled at full rate forever. It exposes `{ data, error, loading, reload }` with stale-but-shown
 * semantics: a failed load/poll/retry never clears the last-good `data`, it only sets `error`
 * (cleared again on the next success) while `loading` flags the in-flight window. `reload()` has a
 * stable identity and is a no-op while a request is already in flight or while `load` is `null` —
 * pass `load: null` for an idle "nothing selected yet" state, which issues no request and reports
 * `{ data: null, error: null, loading: false }`. A `deps` change is a hard reset (`data`/`error`
 * back to `null`, `loading` to `true`) and gates out whatever request was still in flight from
 * before the change, so it can never land.
 */
export function useAsyncResource<T>(
  load: (() => Promise<T>) | null,
  deps: DependencyList,
  options?: { pollMs?: number },
): AsyncResource<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: load !== null,
  });

  const loadRef = useRef(load);
  const pollMsRef = useRef(options?.pollMs);
  useLayoutEffect(() => {
    loadRef.current = load;
    pollMsRef.current = options?.pollMs;
  });

  const isRerunRef = useRef(false);
  const reloadImplRef = useRef<() => void>(() => {});
  const reload = useCallback(() => reloadImplRef.current(), []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are forwarded verbatim from the caller, same as useLiveEffect itself; this generic wrapper cannot statically know them
  useLiveEffect((live) => {
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    const run = () => {
      const current = loadRef.current;
      if (current === null || inFlight) return;
      inFlight = true;
      setState((s) => ({ ...s, loading: true }));
      current().then(
        (data) => {
          inFlight = false;
          if (!live()) return;
          failures = 0;
          setState({ data, error: null, loading: false });
          schedulePoll();
        },
        (error: unknown) => {
          inFlight = false;
          if (!live()) return;
          failures += 1;
          setState((s) => ({ ...s, error: errorText(error), loading: false }));
          schedulePoll();
        },
      );
    };

    const schedulePoll = () => {
      const pollMs = pollMsRef.current;
      if (pollMs == null) return;
      const delay = failures === 0 ? pollMs : Math.min(pollMs * 2 ** failures, Math.max(pollMs * 8, 30_000));
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delay);
    };

    reloadImplRef.current = () => {
      if (!live() || inFlight || loadRef.current === null) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      failures = 0;
      run();
    };

    if (isRerunRef.current) setState({ data: null, error: null, loading: load !== null });
    isRerunRef.current = true;

    if (load !== null) run();

    return () => {
      if (timer !== null) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are forwarded verbatim from the caller, same as useLiveEffect itself; this generic wrapper cannot statically know them
  }, deps);

  return { ...state, reload };
}
