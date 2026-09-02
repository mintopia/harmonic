import type { ApiTask, ApiTaskListRow, ApiAttemptSummary, ApiAttempt, ApiAttemptUsage } from '../src/server/dto.js';
import type { Task, AttemptSummary, Attempt, AttemptUsageEvent } from '../web/src/types.js';

type AssertAssignable<Sub extends Sup, Sup> = Sub;

export type _TaskDetailContract = AssertAssignable<ApiTask, Task>;
// prompt omitted: ADR-0011
export type _TaskListContract = AssertAssignable<ApiTaskListRow, Omit<Task, 'prompt'>>;
export type _AttemptSummaryContract = AssertAssignable<ApiAttemptSummary, AttemptSummary>;
export type _AttemptTimelineContract = AssertAssignable<ApiAttempt, Attempt>;
export type _AttemptUsageContract = AssertAssignable<{ attemptId: number } & ApiAttemptUsage, AttemptUsageEvent>;
