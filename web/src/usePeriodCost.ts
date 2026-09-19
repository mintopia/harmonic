import { useEffect, useRef, useState } from 'react';
import { debounce } from './debounce';
import { useLiveEffect } from './useLiveEffect';
import type { Cost, Task } from './types';

export function usePeriodCost(
  authed: boolean,
  tasks: Task[] | null,
  workspaceId: number | null,
  fetchImpl: typeof fetch = fetch,
) {
  const [cost, setCost] = useState<Cost | null>(null);
  const taskListSignature = tasks ? `${tasks.length}:${tasks.filter((t) => t.state === 'working').length}` : '';
  const refresh = useRef<(() => void) | null>(null);
  const signatureSettled = useRef(false);
  useLiveEffect((live) => {
    if (!authed || workspaceId === null) {
      refresh.current = null;
      return;
    }
    const load = () => {
      const to = Date.now();
      fetchImpl(`/api/stats?from=${to - 24 * 3600_000}&to=${to}&workspaceId=${workspaceId}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((s: { cost: Cost | null } | null) => live() && s && setCost(s.cost))
        .catch(() => {});
    };
    const debounced = debounce(load, 1000);
    refresh.current = debounced;
    signatureSettled.current = false;
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      clearInterval(timer);
      debounced.cancel();
      refresh.current = null;
    };
  }, [authed, workspaceId, fetchImpl]);
  useEffect(() => {
    if (!signatureSettled.current) {
      signatureSettled.current = true;
      return;
    }
    refresh.current?.();
  }, [taskListSignature]);
  return cost;
}
