/* eslint-disable */
// Stub of the `api` surface for the story harness — resolves fixtures, no network.
import * as f from './fixtures';

const ok = <T>(v: T) => Promise.resolve(v);

export const api = {
  tasks: () => ok({ tasks: [f.task] }),
  task: (_id: number) => ok(f.task),
  taskTimeline: (_id: number) => ok({ events: f.timeline }),
  taskAttemptTimeline: (_id: number) => ok({ attempts: f.attempts }),
  taskAttempts: (_id: number) => ok({ attempts: f.runs }),
  config: () => ok(f.config),
  workspaces: () => ok({ workspaces: f.workspaces }),
  attemptLog: (_id: number) => ok({ status: 'available', events: f.attemptLog, liveCursor: 999 }),
  criticLog: (_id: number) => ok({ status: 'available', events: [] }),
  attemptGuardrailEvents: (_id: number) => ok({ guardrailEvents: [] }),
  attemptVerificationAttempts: (_id: number) => ok({ verificationAttempts: f.verificationAttempts, verifierStatuses: f.verifierStatuses }),
  attemptDiffFiles: (_id: number) => ok({ files: f.diffFiles }),
  attemptDiff: (_id: number) => ok({ stat: f.task.stat }),
  steerTask: (_id: number, _msg: string) => ok(undefined),
} as any;
