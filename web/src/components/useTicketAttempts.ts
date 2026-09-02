import { useState } from 'react';
import { api } from '../api';
import { subscribe } from '../ws';
import { useLiveEffect } from '../useLiveEffect';
import { toastError } from '../toast';
import type { Attempt, AttemptSummary } from '../types';

/** The Task's two attempt lists: `runs` (the AttemptSummary rows the metrics,
 * stats and gate read) and `attempts` (the richer per-Attempt timeline the
 * sidebar and Attempt panel read). Both hydrate on mount and track their own
 * live channel. */
export function useTicketAttempts(taskId: number): { runs: AttemptSummary[]; attempts: Attempt[] } {
  const [runs, setRuns] = useState<AttemptSummary[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);

  useLiveEffect((live) => {
    const load = () =>
      api.taskAttemptTimeline(taskId).then(({ attempts: next }) => {
        if (!live()) return;
        setAttempts(next);
      }, toastError);
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'attempt_timeline_changed' && msg.taskId === taskId) {
        setAttempts(msg.attempts);
      }
    }, load);
    return () => {
      unsubscribe();
    };
  }, [taskId]);

  useLiveEffect((live) => {
    const load = () =>
      api.taskAttempts(taskId).then(({ attempts: list }) => {
        if (!live()) return;
        setRuns(list);
      });
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'attempt_changed' && msg.run.taskId === taskId) {
        setRuns((current) => {
          const rest = current.filter((r) => r.id !== msg.run.id);
          return [...rest, msg.run].sort((a, b) => a.number - b.number);
        });
      }
    }, load);
    return () => {
      unsubscribe();
    };
  }, [taskId]);

  return { runs, attempts };
}
