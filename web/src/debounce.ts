/**
 * Trailing-edge debounce: a burst of calls within `delayMs` of each other
 * collapses to a single invocation, fired `delayMs` after the last call with
 * that last call's arguments. Used to fold a `task_changed` firehose into one
 * epics refetch rather than one network round trip per event.
 */
export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  /** Drop any pending trailing call — for effect cleanup, so a fire can't land
   * after unsubscribe. */
  cancel(): void;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs: number,
): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: A) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, delayMs);
  };
  debounced.cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return debounced;
}
