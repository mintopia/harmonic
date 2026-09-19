import { useCallback, useState } from 'react';
import { useLiveEffect } from './useLiveEffect';

export interface AuthState {
  authed: boolean | null;
  passwordSet: boolean;
  login: () => void;
  logout: () => void;
}

export function useAuth(fetchImpl: typeof fetch = fetch): AuthState {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [passwordSet, setPasswordSet] = useState(true);

  useLiveEffect((live) => {
    fetchImpl('/api/auth/me')
      .then((r) => r.json())
      .then((me: { authenticated: boolean; passwordConfigured: boolean }) => {
        if (!live()) return;
        setPasswordSet(me.passwordConfigured);
        setAuthed(me.authenticated || !me.passwordConfigured);
      })
      .catch(() => live() && setAuthed(false));
  }, [fetchImpl]);

  const login = useCallback(() => setAuthed(true), []);
  const logout = useCallback(() => {
    fetchImpl('/api/auth/logout', { method: 'POST' }).then(() => setAuthed(false));
  }, [fetchImpl]);

  return { authed, passwordSet, login, logout };
}
