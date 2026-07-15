import { EventEmitter } from 'node:events';
import type { ConversationRow, RunRow, TaskRow } from '../db/schema.js';
import type { PersistedRunEvent } from '../domain/runs.js';
import type { PersistedConversationEvent } from '../domain/conversations.js';

export interface BusEvents {
  run_event: (event: PersistedRunEvent) => void;
  run_changed: (run: RunRow) => void;
  task_changed: (task: TaskRow) => void;
  conversation_event: (event: PersistedConversationEvent) => void;
  conversation_changed: (conversation: ConversationRow) => void;
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
