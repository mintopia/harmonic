import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { IMPLEMENTATION_PROMPT_LOCATOR } from '../../resolved-prompt-model';

interface Loaded {
  attemptId: number;
  prompts: string[];
}

// A failed read keeps already-held prompts.
export function useTurnPrompts(attemptId: number, promptsSent: number): string[] {
  const [state, setState] = useState<Loaded>({ attemptId, prompts: [] });
  const held = useRef<Loaded>(state);
  useEffect(() => {
    let live = true;
    const have = held.current.attemptId === attemptId ? held.current.prompts : [];
    const load = async (): Promise<string[]> => {
      if (have.length === 0) return api.attemptResolvedPrompts(attemptId, IMPLEMENTATION_PROMPT_LOCATOR);
      const next = [...have];
      for (let index = have.length; index < promptsSent; index++) {
        next.push(await api.resolvedPrompt({ attemptId }, IMPLEMENTATION_PROMPT_LOCATOR, index));
      }
      return next;
    };
    load().then(
      (prompts) => {
        if (!live) return;
        held.current = { attemptId, prompts };
        setState(held.current);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [attemptId, promptsSent]);
  return state.attemptId === attemptId ? state.prompts : [];
}
