import type { TaskState } from './types.js';

export const TERMINAL_STATES = ['completed', 'failed', 'cancelled'] as const satisfies readonly TaskState[];
