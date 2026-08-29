import { EventEmitter } from 'node:events';
import type { ConversationRow, RunRow, TaskRow } from '../db/schema.js';
import type { PersistedRunEvent } from '../domain/runs.js';
import type { LiveRunEvent } from '../execution/runner.js';
import type { PersistedConversationEvent } from '../domain/conversations.js';
import type { PendingPermissionBroadcast } from '../execution/conversation-driver.js';
import type { RunUsageSnapshot } from '../execution/usage.js';
import type { ScheduledJobSnapshot } from '../scheduler/scheduler.js';
import type { OperationEvent } from '../telemetry/operations.js';
import type { FlaggedWorktree } from '../domain/flagged-worktrees.js';

export interface BusEvents {
  operations: (event: OperationEvent) => void;
  run_event: (event: PersistedRunEvent) => void;
  run_log_event: (event: LiveRunEvent) => void;
  run_changed: (run: RunRow) => void;
  /** Live-usage snapshot pushed ~1s while a run tails its native log (ADR 0010). */
  run_usage: (payload: { runId: number; snapshot: RunUsageSnapshot }) => void;
  task_changed: (task: TaskRow) => void;
  /** A Task's row was hard-deleted (issue #162, ADR-0025); a live board drops
   * it immediately rather than waiting on the next full list. */
  task_removed: (payload: { id: number }) => void;
  conversation_event: (event: PersistedConversationEvent) => void;
  conversation_changed: (conversation: ConversationRow) => void;
  permission_request: (pending: PendingPermissionBroadcast) => void;
  /** Full Scheduled Jobs registry snapshot (ADR-0038). */
  scheduled_jobs: (jobs: ScheduledJobSnapshot[]) => void;
  /** Full flagged-worktree disposition registry snapshot (ADR-0010, issue #386). */
  flagged_worktrees: (flags: readonly FlaggedWorktree[]) => void;
}

/** In-process pub/sub feeding the WebSocket stream (and later, notifications). */
export class EventBus {
  private emitter = new EventEmitter();
  private readonly runLogEvents = new Map<number, LiveRunEvent[]>();
  private static readonly maxRunLogEvents = 2_048;

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<K extends keyof BusEvents>(event: K, ...args: Parameters<BusEvents[K]>): void {
    this.emitter.emit(event, ...args);
  }

  /** Add a transient ACP update to the active Run's reconnect buffer. */
  emitRunLog(event: LiveRunEvent): void {
    const events = this.runLogEvents.get(event.runId) ?? [];
    events.push(event);
    if (events.length > EventBus.maxRunLogEvents) events.splice(0, events.length - EventBus.maxRunLogEvents);
    this.runLogEvents.set(event.runId, events);
    this.emitter.emit('run_log_event', event);
  }

  *replayRunLog({ runId, after }: { runId: number; after: number }): IterableIterator<LiveRunEvent> {
    for (const event of this.runLogEvents.get(runId) ?? []) {
      if (event.seq > after) yield event;
    }
  }

  /** The current live-stream watermark, used to cut REST hydration over to WS. */
  latestRunLogSeq({ runId }: { runId: number }): number {
    const events = this.runLogEvents.get(runId);
    return events?.[events.length - 1]?.seq ?? 0;
  }

  on<K extends keyof BusEvents>(event: K, listener: BusEvents[K]): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return () => this.emitter.off(event, listener as (...args: unknown[]) => void);
  }
}
