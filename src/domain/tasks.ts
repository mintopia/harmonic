import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { tasks, type TaskRow, type TaskState } from '../db/schema.js';
import { HARNESS_IDS, ISOLATION_MODES, PRIORITIES, type AppConfig } from '../config.js';
import { DomainError } from './errors.js';

export const createTaskInputSchema = z.object({
  prompt: z.string().min(1, 'prompt is required'),
  harness: z.enum(HARNESS_IDS).optional(),
  model: z.string().min(1).optional(),
  workingDir: z.string().min(1).optional(),
  isolationMode: z.enum(ISOLATION_MODES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  state: z.enum(['draft', 'ready']).optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const updateTaskInputSchema = createTaskInputSchema.omit({ state: true }).partial();
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

/** States an operator may edit a task in. */
const EDITABLE_STATES: TaskState[] = ['draft', 'ready'];
/** States a task can be cancelled from — everything not terminal. */
const CANCELLABLE_STATES: TaskState[] = [
  'draft',
  'blocked',
  'ready',
  'running',
  'awaiting-review',
  'failed',
];

export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly getConfig: () => AppConfig,
  ) {}

  create(input: CreateTaskInput): TaskRow {
    const config = this.getConfig();
    const harness = input.harness ?? config.defaults.harness;
    const harnessConfig = config.harnesses[harness];
    if (!harnessConfig) throw new DomainError('validation', `harness '${harness}' is not configured`);
    const now = Date.now();
    const row = this.db
      .insert(tasks)
      .values({
        prompt: input.prompt,
        harness,
        model: input.model ?? harnessConfig.defaultModel,
        workingDir: input.workingDir ?? config.defaults.workingDir,
        isolationMode: input.isolationMode ?? config.defaults.isolationMode,
        priority: input.priority ?? config.defaults.priority,
        state: input.state ?? 'ready',
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return row;
  }

  list(): TaskRow[] {
    return this.db.select().from(tasks).all();
  }

  get(id: number): TaskRow {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) throw new DomainError('not_found', `task ${id} not found`);
    return row;
  }

  update(id: number, input: UpdateTaskInput): TaskRow {
    const task = this.get(id);
    if (!EDITABLE_STATES.includes(task.state)) {
      throw new DomainError('invalid_state', `task ${id} is ${task.state}; only draft or ready tasks can be edited`);
    }
    if (input.harness) {
      const config = this.getConfig();
      if (!config.harnesses[input.harness]) {
        throw new DomainError('validation', `harness '${input.harness}' is not configured`);
      }
    }
    return this.db
      .update(tasks)
      .set({ ...input, updatedAt: Date.now() })
      .where(eq(tasks.id, id))
      .returning()
      .get()!;
  }

  /** Promote a draft to ready. */
  promote(id: number): TaskRow {
    const task = this.get(id);
    if (task.state !== 'draft') {
      throw new DomainError('invalid_state', `task ${id} is ${task.state}; only drafts can be promoted to ready`);
    }
    return this.setState(id, 'ready');
  }

  cancel(id: number): TaskRow {
    const task = this.get(id);
    if (!CANCELLABLE_STATES.includes(task.state)) {
      throw new DomainError('invalid_state', `task ${id} is ${task.state}, which is terminal`);
    }
    return this.setState(id, 'cancelled');
  }

  setState(id: number, state: TaskState): TaskRow {
    return this.db
      .update(tasks)
      .set({ state, updatedAt: Date.now() })
      .where(eq(tasks.id, id))
      .returning()
      .get()!;
  }
}
