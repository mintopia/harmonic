import type { ApiTask, ApiTaskListRow, ApiAttemptSummary, ApiAttempt, ApiAttemptUsage } from '../src/server/dto.js';
import type { Task, AttemptSummary, Attempt, AttemptUsageEvent } from '../web/src/types.js';

/** `Sub` must be assignable to `Sup`; a divergence fails typecheck here. */
type AssertAssignable<Sub extends Sup, Sup> = Sub;

// Detail GET /api/tasks/:id + WS task_changed
export type _TaskDetailContract = AssertAssignable<ApiTask, Task>;
// List GET /api/tasks (prompt intentionally omitted — ADR-0011)
export type _TaskListContract = AssertAssignable<ApiTaskListRow, Omit<Task, 'prompt'>>;
// WS attempt_changed + GET /api/attempts/:id
export type _AttemptSummaryContract = AssertAssignable<ApiAttemptSummary, AttemptSummary>;
// WS attempt_timeline_changed
export type _AttemptTimelineContract = AssertAssignable<ApiAttempt, Attempt>;
// WS attempt_usage ( { type, attemptId, ...ApiAttemptUsage } minus the literal type tag )
export type _AttemptUsageContract = AssertAssignable<{ attemptId: number } & ApiAttemptUsage, AttemptUsageEvent>;
