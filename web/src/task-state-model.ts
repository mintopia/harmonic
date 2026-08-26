import type { TaskState } from './types.js';

export const TERMINAL_STATES = ['done', 'cancelled'] as const satisfies readonly TaskState[];
