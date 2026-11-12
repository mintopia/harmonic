import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';

interface Loaded {
  key: string;
  prompts: string[];
}

// A failed read keeps already-held prompts.
export function useTurnPrompts(attemptId: number, locator: string, promptsSent: number, enabled = true): string[] {
  const key = `${attemptId}:${locator}`;
  const [state, setState] = useState<Loaded>({ key, prompts: [] });
  const held = useRef<Loaded>(state);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const have = held.current.key === key ? held.current.prompts : [];
    const load = async (): Promise<string[]> => {
      if (have.length === 0) return api.attemptResolvedPrompts(attemptId, locator);
      const next = [...have];
      for (let index = have.length; index < promptsSent; index++) {
        next.push(await api.resolvedPrompt({ attemptId }, locator, index));
      }
      return next;
    };
    load().then(
      (prompts) => {
        if (!live) return;
        held.current = { key, prompts };
        setState(held.current);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [attemptId, locator, key, promptsSent, enabled]);
  return state.key === key ? state.prompts : [];
}
