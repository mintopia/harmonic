/* eslint-disable */
// Stub of the `api` surface for the story harness — resolves fixtures, no network.
import * as f from './fixtures';

const ok = <T>(v: T) => Promise.resolve(v);

// Some component graphs import `request` from `../api` directly; the story never
// hits the network, so resolve to nothing rather than provide a real client.
export const request = <T>() => Promise.resolve(undefined as T);

export const api = {
  tasks: (opts?: { parent?: number }) =>
    opts?.parent !== undefined ? ok({ tasks: f.epicChildren, total: f.epicChildren.length }) : ok({ tasks: [f.task], total: 1 }),
  task: (_id: number) => ok(f.task),
  epic: (_workspaceId: number, _epicRef: number) => ok(f.epic),
  epicStats: (_epicRef: number, _workspaceId: number) => ok(f.epicStats),
  taskUsage: (id: number) =>
    ok(f.epicChildUsage[id] ?? { models: {}, agents: {}, toolCalls: {}, totals: null, source: null, cost: null, attemptCount: 0 }),
  taskTimeline: (_id: number) => ok({ events: f.timeline }),
  taskAttemptTimeline: (_id: number) => ok({ attempts: f.attempts }),
  taskAttempts: (_id: number) => ok({ attempts: f.runs }),
  config: () => ok(f.config),
  workspaces: () => ok({ workspaces: f.workspaces }),
  attemptLog: (_id: number) => ok({ status: 'available', events: f.attemptLog, liveCursor: 999 }),
  criticLog: (_id: number) => ok({ status: 'available', events: f.criticLog, liveCursor: 999 }),
  attemptGuardrailEvents: (_id: number) => ok({ guardrailEvents: [] }),
  attemptVerificationAttempts: (_id: number) => ok({ verificationAttempts: f.verificationAttempts, verifierStatuses: f.verifierStatuses }),
  attemptDiffFiles: (_id: number) => ok({ files: f.diffFiles }),
  attemptDiff: (_id: number) => ok({ stat: f.task.stat }),
  steerTask: (_id: number, _msg: string) => ok(undefined),
} as any;
