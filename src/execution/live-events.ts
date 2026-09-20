export const LIVE_RUN_LOG_EVENT_ID_OFFSET = 1_000_000_000;

/** A live ACP update, with an Attempt-local monotonic id for reconnect de-duplication. */
export interface LiveAttemptEvent {
  id: number;
  attemptId: number;
  seq: number;
  ts: number;
  type: 'session_update';
  payload: { sessionUpdate: string; [key: string]: unknown };
}
