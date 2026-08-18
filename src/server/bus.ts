import { EventEmitter } from 'node:events';
import type { ConversationRow, RunRow, TaskRow } from '../db/schema.js';
import type { PersistedRunEvent } from '../domain/runs.js';
import type { PersistedConversationEvent } from '../domain/conversations.js';
import type { PendingPermissionBroadcast } from '../execution/conversation-driver.js';
import type { RunUsageSnapshot } from '../execution/usage.js';

export interface BusEvents {
  run_event: (event: PersistedRunEvent) => void;
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
}

/** In-process pub/sub feeding the WebSocket stream (and later, notifications). */
export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<K extends keyof BusEvents>(event: K, ...args: Parameters<BusEvents[K]>): void {
    this.emitter.emit(event, ...args);
  }

  on<K extends keyof BusEvents>(event: K, listener: BusEvents[K]): () => void {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return () => this.emitter.off(event, listener as (...args: unknown[]) => void);
  }
}
