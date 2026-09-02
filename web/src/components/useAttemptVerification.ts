import { useState } from 'react';
import { api } from '../api';
import { subscribe } from '../ws';
import { useLiveEffect } from '../useLiveEffect';
import type { VerificationAttempt, VerifierStatus } from '../types';

/** The selected Attempt's verification: the recorded attempts and the per-verifier
 * statuses the Verify/Review tabs and the gate read. Reloads on each
 * `attempt_changed` for the selected Attempt; cleared when nothing is selected. */
export function useAttemptVerification(attemptId: number | null): {
  verificationAttempts: VerificationAttempt[];
  verifierStatuses: VerifierStatus[];
} {
  const [verificationAttempts, setVerificationAttempts] = useState<VerificationAttempt[]>([]);
  const [verifierStatuses, setVerifierStatuses] = useState<VerifierStatus[]>([]);

  useLiveEffect((live) => {
    if (attemptId === null) {
      setVerificationAttempts([]);
      setVerifierStatuses([]);
      return;
    }
    const load = () =>
      api.attemptVerificationAttempts(attemptId).then(({ verificationAttempts, verifierStatuses }) => {
        if (!live()) return;
        setVerificationAttempts(verificationAttempts);
        setVerifierStatuses(verifierStatuses);
      });
    const unsubscribe = subscribe((msg) => {
      if (msg.type === 'attempt_changed' && msg.run.id === attemptId) load();
    }, load);
    return () => {
      unsubscribe();
    };
  }, [attemptId]);

  return { verificationAttempts, verifierStatuses };
}
