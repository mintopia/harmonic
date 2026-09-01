import { useEffect, type DependencyList } from 'react';

/**
 * A useEffect for async work whose result must not land after teardown. The
 * effect body receives a `live()` predicate that returns true while mounted and
 * flips to false on cleanup — guard state updates with it so a fetch that
 * resolves after the deps change (or the component unmounts) is a no-op:
 *
 *     useLiveEffect((live) => {
 *       api.thing().then((x) => live() && setThing(x), toastError);
 *     }, [id]);
 *
 * Return an optional cleanup for timers/subscriptions; it runs alongside the
 * liveness flip on the same teardown.
 */
export function useLiveEffect(
  effect: (live: () => boolean) => void | (() => void),
  deps: DependencyList,
): void {
  useEffect(() => {
    let alive = true;
    const cleanup = effect(() => alive);
    return () => {
      alive = false;
      cleanup?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are forwarded verbatim from the caller; this generic wrapper cannot statically know them
  }, deps);
}
