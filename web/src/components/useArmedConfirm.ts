import { useEffect, useRef, useState } from 'react';

/** How long an armed destructive action waits before reverting on its own. */
export const ARM_TIMEOUT_MS = 3000;

/**
 * Two-step inline confirm for a destructive action (DESIGN.md bans native
 * confirm()): the first click arms, the second within ARM_TIMEOUT_MS commits.
 * Clicking anywhere outside the button, or letting the timeout elapse, reverts
 * — so a stray first click never leaves a primed action lying in wait. Shared
 * by the Board/detail task Cancel (TaskActions) and the Activity row's Stop
 * (issue #55): "no single misclick kills a run".
 */
export function useArmedConfirm(onConfirm: () => void) {
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!armed) return;
    const revert = () => setArmed(false);
    const timer = setTimeout(revert, ARM_TIMEOUT_MS);
    // mousedown (not click) so a press that starts outside reverts before it
    // can register as the confirming click elsewhere.
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) revert();
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onDown);
    };
  }, [armed]);

  const trigger = () => {
    if (armed) {
      setArmed(false);
      onConfirm();
    } else {
      setArmed(true);
    }
  };

  return { armed, trigger, ref };
}
