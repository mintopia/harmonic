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
  /** The critic's own live ACP transcript, streamed on its own channel keyed by
   * the builder Attempt id — kept apart from `attempt_log_event` so the running
   * critic renders as its own chat without leaking into the Implementation lane. */
  critic_log_event: (event: LiveAttemptEvent) => void;
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
  /** An Epic's integration merge advanced a step; a live board refreshes its
   * merge progress (Epics have no Attempt row, so `attempt_event` never covers this). */
  epic_changed: (payload: { workspaceId: number; epicRef: number }) => void;
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
  private readonly criticLogEvents = new Map<number, LiveAttemptEvent[]>();
  private static readonly maxRunLogEvents = 2_048;

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<K extends keyof BusEvents>(event: K, ...args: Parameters<BusEvents[K]>): void {
    this.emitter.emit(event, ...args);
  }

  private static buffer(map: Map<number, LiveAttemptEvent[]>, event: LiveAttemptEvent): void {
    const events = map.get(event.attemptId) ?? [];
    events.push(event);
    if (events.length > EventBus.maxRunLogEvents) events.splice(0, events.length - EventBus.maxRunLogEvents);
    map.set(event.attemptId, events);
  }

  private static *replay(map: Map<number, LiveAttemptEvent[]>, attemptId: number, after: number): IterableIterator<LiveAttemptEvent> {
    for (const event of map.get(attemptId) ?? []) {
      if (event.seq > after) yield event;
    }
  }

  /** Add a transient ACP update to the active Attempt's reconnect buffer. */
  emitAttemptLog(event: LiveAttemptEvent): void {
    EventBus.buffer(this.attemptLogEvents, event);
    this.emitter.emit('attempt_log_event', event);
  }

  *replayAttemptLog({ attemptId, after }: { attemptId: number; after: number }): IterableIterator<LiveAttemptEvent> {
    yield* EventBus.replay(this.attemptLogEvents, attemptId, after);
  }

  /** The current live-stream watermark, used to cut REST hydration over to WS. */
  latestAttemptLogSeq({ attemptId }: { attemptId: number }): number {
    const events = this.attemptLogEvents.get(attemptId);
    return events?.[events.length - 1]?.seq ?? 0;
  }

  /** The critic's own live ACP transcript channel — same buffer/replay shape as
   * {@link emitAttemptLog}, in a separate keyspace so it never mixes with the
   * builder's Implementation stream. */
  emitCriticLog(event: LiveAttemptEvent): void {
    EventBus.buffer(this.criticLogEvents, event);
    this.emitter.emit('critic_log_event', event);
  }

  *replayCriticLog({ attemptId, after }: { attemptId: number; after: number }): IterableIterator<LiveAttemptEvent> {
    yield* EventBus.replay(this.criticLogEvents, attemptId, after);
  }

  on<K extends keyof BusEvents>(event: K, listener: BusEvents[K]): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return () => this.emitter.off(event, listener as (...args: unknown[]) => void);
  }
}
