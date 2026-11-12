import { useState } from 'react';
import { api } from '../api';
import { useLiveEffect } from '../useLiveEffect';
import type { AttemptLogEvent } from '../types';

type Log = { events: AttemptLogEvent[]; unavailable: boolean; fromArchive: boolean; loading: boolean };

/** One step run's recorded transcript, read once when `enabled` (a row opened) and again when the run ends. */
export function useStepRunLog(stepRunId: number, enabled: boolean, endedAt: number | null): Log {
  const [log, setLog] = useState<Log>({ events: [], unavailable: false, fromArchive: false, loading: true });
  useLiveEffect((live) => {
    if (!enabled) return;
    api.stepRunLog(stepRunId).then(
      (res) => live() && setLog({ events: res.status === 'available' ? res.events : [], unavailable: res.status === 'unavailable', fromArchive: res.status === 'available' && res.fromArchive === true, loading: false }),
      () => live() && setLog({ events: [], unavailable: true, fromArchive: false, loading: false }),
    );
  }, [stepRunId, enabled, endedAt]);
  return log;
}
