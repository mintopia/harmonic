/** Run `run` at most once at a time; a call during an in-flight pass schedules exactly one trailing rerun, and every waiter resolves with that final pass's result. */
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  let again = false;

  const cycle = async (): Promise<T> => {
    try {
      let result: T;
      do {
        again = false;
        result = await run();
      } while (again);
      return result;
    } finally {
      inFlight = null;
    }
  };

  return (): Promise<T> => {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    inFlight = cycle();
    return inFlight;
  };
}
