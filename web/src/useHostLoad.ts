import { useState } from 'react';
import { useLiveEffect } from './useLiveEffect';
import { subscribe, type HostLoad } from './ws';

export function useHostLoad(authed: boolean | null, activeWorkspaceId: number | null): HostLoad | null {
  const [hostLoad, setHostLoad] = useState<HostLoad | null>(null);
  useLiveEffect((live) => {
    if (!authed || activeWorkspaceId === null) return;
    return subscribe((msg) => {
      if (live() && msg.type === 'host_load') setHostLoad(msg.load);
    });
  }, [authed, activeWorkspaceId]);
  return hostLoad;
}
