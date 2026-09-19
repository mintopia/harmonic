import { useCallback, useEffect, useRef, useState } from 'react';
import { parseRoute, serializeRoute, storeLastRoute, type Route } from './router-model';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export type RouteWindow = {
  location: Pick<Location, 'pathname' | 'search'>;
  history: Pick<History, 'replaceState' | 'pushState'>;
  addEventListener: (type: 'popstate', listener: () => void) => void;
  removeEventListener: (type: 'popstate', listener: () => void) => void;
};

export type NavigateFn = (next: Route, opts?: { replace?: boolean }) => void;

export function useRoute(win: RouteWindow = window, storage: StorageLike = localStorage): [Route, NavigateFn] {
  const [route, setRoute] = useState<Route>(() => parseRoute(win.location.pathname, win.location.search));
  const initialRoute = useRef(route);
  useEffect(() => {
    const canonical = serializeRoute(initialRoute.current);
    if (canonical !== `${win.location.pathname}${win.location.search}`) {
      win.history.replaceState(null, '', canonical);
    }
    storeLastRoute(storage, initialRoute.current);
    const onPop = () => {
      const next = parseRoute(win.location.pathname, win.location.search);
      storeLastRoute(storage, next);
      setRoute(next);
    };
    win.addEventListener('popstate', onPop);
    return () => win.removeEventListener('popstate', onPop);
  }, [win, storage]);
  const navigate = useCallback((next: Route, opts?: { replace?: boolean }) => {
    const url = serializeRoute(next);
    if (url === `${win.location.pathname}${win.location.search}`) {
      setRoute(next);
      return;
    }
    if (opts?.replace) win.history.replaceState(null, '', url);
    else win.history.pushState(null, '', url);
    storeLastRoute(storage, next);
    setRoute(next);
  }, [win, storage]);
  return [route, navigate];
}
