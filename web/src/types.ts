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

/** Dollar value of Usage, computed server-side on read — never stored. */
export interface Cost {
  /** Sum over priced models; null when nothing could be priced. */
  totalUsd: number | null;
  /** $ per model; null for models without a price entry. */
  byModel: Record<string, number | null>;
  /** True when some tokens could not be priced — the total is a floor. */
  incomplete: boolean;
}

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
  /** Summed over ALL runs, retries and failed attempts included. */
  cost: Cost | null;
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
  usage: {
    totals: Record<string, number | null> | null;
    models: Record<string, Record<string, number>>;
    toolCalls: Record<string, number>;
    source: string | null;
  } | null;
  cost: Cost | null;
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
