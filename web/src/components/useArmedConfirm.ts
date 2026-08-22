import { useEffect, useRef, useState } from 'react';

/** How long an armed destructive action waits before reverting on its own. */
export const ARM_TIMEOUT_MS = 3000;

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
