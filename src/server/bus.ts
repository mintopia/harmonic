import { EventEmitter } from 'node:events';
import type { ConversationRow, AttemptRow, TaskRow } from '../db/schema.js';
import type { PersistedAttemptEvent } from '../domain/attempts.js';
import type { LiveAttemptEvent } from '../execution/runner.js';
import type { PersistedConversationEvent } from '../domain/conversations.js';
import type { PendingPermissionBroadcast } from '../execution/conversation-driver.js';
import type { AttemptUsageSnapshot } from '../execution/usage.js';
import type { ScheduledJobSnapshot } from '../scheduler/scheduler.js';
import type { OperationEvent } from '../telemetry/operations.js';
import type { FlaggedWorktree, FlaggedWorktreeEmitter } from '../domain/flagged-worktrees.js';

export interface BusEvents {
  operations: (event: OperationEvent) => void;
  attempt_event: (event: PersistedAttemptEvent) => void;
  attempt_log_event: (event: LiveAttemptEvent) => void;
  attempt_changed: (run: AttemptRow) => void;
  /** A Step transitioned within a still-running Attempt (Implementation →
   * Verify → Review). The Attempt row is unchanged, so `attempt_changed` never
   * fires here; this is what refreshes the Task-detail timeline mid-Attempt. */
  step_changed: (payload: { taskId: number }) => void;
  /** Live-usage snapshot pushed ~1s while an Attempt tails its native log. */
  attempt_usage: (payload: { attemptId: number; snapshot: AttemptUsageSnapshot }) => void;
  task_changed: (task: TaskRow) => void;
  /** A Task's row was hard-deleted; a live board drops it immediately. */
  task_removed: (payload: { id: number }) => void;
  conversation_event: (event: PersistedConversationEvent) => void;
  conversation_changed: (conversation: ConversationRow) => void;
  permission_request: (pending: PendingPermissionBroadcast) => void;
  /** Full Scheduled Jobs registry snapshot. */
  scheduled_jobs: (jobs: ScheduledJobSnapshot[]) => void;
  /** Full flagged-worktree disposition registry snapshot. */
  flagged_worktrees: (flags: readonly FlaggedWorktree[]) => void;
}

/** In-process pub/sub feeding the WebSocket stream. */
export class EventBus implements FlaggedWorktreeEmitter {
  private emitter = new EventEmitter();
  private readonly attemptLogEvents = new Map<number, LiveAttemptEvent[]>();
  private static readonly maxRunLogEvents = 2_048;

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<K extends keyof BusEvents>(event: K, ...args: Parameters<BusEvents[K]>): void {
    this.emitter.emit(event, ...args);
  }

  /** Add a transient ACP update to the active Attempt's reconnect buffer. */
  emitAttemptLog(event: LiveAttemptEvent): void {
    const events = this.attemptLogEvents.get(event.attemptId) ?? [];
    events.push(event);
    if (events.length > EventBus.maxRunLogEvents) events.splice(0, events.length - EventBus.maxRunLogEvents);
    this.attemptLogEvents.set(event.attemptId, events);
    this.emitter.emit('attempt_log_event', event);
  }

  *replayAttemptLog({ attemptId, after }: { attemptId: number; after: number }): IterableIterator<LiveAttemptEvent> {
    for (const event of this.attemptLogEvents.get(attemptId) ?? []) {
      if (event.seq > after) yield event;
    }
  }

  /** The current live-stream watermark, used to cut REST hydration over to WS. */
  latestAttemptLogSeq({ attemptId }: { attemptId: number }): number {
    const events = this.attemptLogEvents.get(attemptId);
    return events?.[events.length - 1]?.seq ?? 0;
  }

  on<K extends keyof BusEvents>(event: K, listener: BusEvents[K]): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return () => this.emitter.off(event, listener as (...args: unknown[]) => void);
  }
}
