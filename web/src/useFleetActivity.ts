import { useState } from 'react';
import { api } from './api';
import { useLiveEffect } from './useLiveEffect';
import { subscribe } from './ws';

export function useFleetActivity(authed: boolean | null, apiImpl: Pick<typeof api, 'activity'> = api): number {
  const [globalRunningCount, setGlobalRunningCount] = useState(0);
  useLiveEffect((live) => {
    if (!authed) return;
    const load = () =>
      apiImpl.activity().then(
        ({ processes }) => live() && setGlobalRunningCount(processes.filter((process) => process.type === 'attempt').length),
        () => {},
      );
    load();
    const timer = setInterval(load, 10_000);
    const unsubscribe = subscribe((message) => {
      if (message.type === 'attempt_changed') load();
    }, load);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [authed, apiImpl]);
  return globalRunningCount;
}
