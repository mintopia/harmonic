export const TASK_STATES = [
  'draft',
  'blocked',
  'ready',
  'running',
  'awaiting-review',
  'completed',
  'failed',
  'cancelled',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface Task {
  id: number;
  prompt: string;
  harness: string;
  model: string;
  workingDir: string;
  isolationMode: 'direct' | 'worktree';
  priority: 'high' | 'normal' | 'low';
  state: TaskState;
  createdAt: number;
  updatedAt: number;
  dependsOn: number[];
  dependents: number[];
  blockedOnFailed: boolean;
}

export interface Run {
  id: number;
  taskId: number;
  attempt: number;
  state: 'running' | 'completed' | 'failed' | 'cancelled';
  reason: string | null;
  stopReason: string | null;
  sessionId: string | null;
  branch: string | null;
  baseBranch: string | null;
  usage: Record<string, number> | null;
  review: 'accepted' | 'rejected' | null;
  reviewFeedback: string | null;
  reviewedAt: number | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface RunEvent {
  id: number;
  runId: number;
  seq: number;
  ts: number;
  type: 'session_update' | 'permission_request' | 'lifecycle';
  payload: any;
}

export interface HarnessConfig {
  command: string;
  args: string[];
  models: string[];
  defaultModel: string;
}

export interface AppConfig {
  harnesses: Record<string, HarnessConfig>;
  defaults: {
    harness: string;
    workingDir: string;
    isolationMode: 'direct' | 'worktree';
    priority: 'high' | 'normal' | 'low';
  };
  autoRunner: { enabled: boolean; maxConcurrentRuns: number };
}
