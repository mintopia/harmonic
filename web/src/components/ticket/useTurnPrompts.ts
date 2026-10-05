import { useEffect, useState } from 'react';
import { api } from '../../api';
import { IMPLEMENTATION_PROMPT_LOCATOR } from '../../resolved-prompt-model';

// A failed read keeps the last good list; the transcript just shows fewer prompts.
export function useTurnPrompts(attemptId: number, promptsSent: number): string[] {
  const [state, setState] = useState<{ attemptId: number; prompts: string[] }>({ attemptId, prompts: [] });
  useEffect(() => {
    let live = true;
    api.attemptResolvedPrompts(attemptId, IMPLEMENTATION_PROMPT_LOCATOR).then(
      (prompts) => live && setState({ attemptId, prompts }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [attemptId, promptsSent]);
  return state.attemptId === attemptId ? state.prompts : [];
}
