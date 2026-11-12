import { z } from 'zod';
import { WORKFLOW_CHOSEN, WORKFLOW_STEP_OUTCOMES, type WorkflowChosen, type WorkflowStepRunRow } from '../db/schema.js';
import { stepRunKind } from '../domain/step-run-kind.js';
import { parseStepRunOutputs } from './dto.js';
import { stepRunOutputsSchema } from './schemas.js';
import { parseWorkflow, resolveAttemptsMax, type WorkflowDefinition, type WorkflowStepDefinition } from '../domain/workflow.js';
import { parseWorkflowRef } from '../execution/workflow-engine.js';

export const workflowStepsResponseSchema = z.object({
  workflowRef: z.string().nullable().meta({ example: 'implement@1' }),
  workflowChosen: z.enum(WORKFLOW_CHOSEN).nullable().meta({ example: 'explicit' }),
  outline: z
    .array(z.object({ id: z.string().meta({ example: 'verify' }), children: z.array(z.string()).meta({ description: 'Ids of a `parallel:` group\'s steps; empty for a plain step.' }) }))
    .meta({ description: 'Every step of the pinned workflow in execution order; empty for a Ticket without a workflow.' }),
  cleanupCount: z.number().int().meta({ description: 'How many steps the workflow\'s `cleanup:` list runs on done and on Close.', example: 1 }),
  latestVersion: z.number().int().nullable().meta({ description: 'The current Library version of the pinned workflow, which applies from the next Retry; null without a pin or once the workflow left the Library.', example: 5 }),
  stepInfo: z
    .record(z.string(), z.object({
      uses: z.string().meta({ example: 'command' }),
      detail: z.string().nullable().meta({ description: 'What the step runs: the command, the Prompt Library name of an agent step, or the model of a critic.', example: 'npm test' }),
      condition: z.string().nullable().meta({ description: 'The step\'s `if:` expression.', example: 'attempt.number > 1' }),
    }))
    .meta({ description: 'Per step id, what the pinned workflow says the step is: every step, `parallel:` children and `cleanup:` steps included.' }),
  blockStepIds: z.array(z.string()).meta({ description: 'Ids of the steps inside the `attempts:` block.', example: ['resolve', 'verify'] }),
  cleanupIds: z.array(z.string()).meta({ description: 'Ids of the `cleanup:` steps in order.', example: ['cleanup'] }),
  maxAttempts: z.number().int().nullable().meta({ description: 'The `attempts:` block bound with vars resolved; null without a block or when it does not resolve.', example: 3 }),
  steps: z.array(
    z.object({
      id: z.number().int().meta({ example: 73 }),
      attemptId: z.number().int().nullable().meta({ example: 19 }),
      kind: z.enum(['rebase', 'agent', 'check', 'critic', 'publish', 'tracker', 'cleanup', 'marker']).meta({ example: 'check' }),
      sessionRowId: z.number().int().nullable().meta({ example: 12 }),
      stepId: z.string().meta({ example: 'lint' }),
      action: z.string().meta({ example: 'run' }),
      position: z.number().int().meta({ example: 0 }),
      attempt: z.number().int().nullable().meta({ description: 'The `attempts:` block pass this run belongs to, 1-based; null for steps outside the block.', example: 1 }),
      outcome: z.enum(WORKFLOW_STEP_OUTCOMES).nullable().meta({ description: 'Null while the step is running.', example: 'pass' }),
      summary: z.string().nullable().meta({ example: 'command exited 0' }),
      resolvedPrompt: z.string().nullable().meta({ description: 'The prompt an agent step sent, Prompt Library includes expanded; null for other actions.' }),
      outputs: stepRunOutputsSchema,
      startedAt: z.number().meta({ example: 1784030400000 }),
      endedAt: z.number().nullable().meta({ example: 1784030401000 }),
    }),
  ),
});

export async function pinnedWorkflow(library: { getVersion(name: string, version: number): Promise<{ text: string }> }, ref: string): Promise<WorkflowDefinition | null> {
  const { name, version } = parseWorkflowRef(ref);
  try {
    return parseWorkflow((await library.getVersion(name, version)).text, { lenient: true });
  } catch {
    return null;
  }
}


interface WorkflowLibrary {
  getVersion(name: string, version: number): Promise<{ text: string }>;
  list(): { name: string; version: number }[];
}

const SHORT_NAME = /^[\w-]+$/;

export function describeStep(step: WorkflowStepDefinition): { uses: string; detail: string | null; condition: string | null } {
  const uses = step.run !== undefined ? 'command' : (step.uses ?? 'command');
  const text = (key: string): string | null => (typeof step.with?.[key] === 'string' ? (step.with[key] as string) : null);
  const prompt = text('prompt');
  const detail = step.run !== undefined ? step.run : uses === 'agent' ? (prompt !== null && SHORT_NAME.test(prompt) ? `prompt ${prompt}` : null) : uses === 'critic' ? text('model') : uses === 'cleanup' ? text('run') : null;
  return { uses, detail, condition: step.if?.replace(/^\$\{\{\s*|\s*\}\}$/g, '') ?? null };
}

export const stepInfoOf = (definition: WorkflowDefinition | null) =>
  Object.fromEntries([...(definition?.steps ?? []), ...(definition?.cleanup ?? [])].flatMap((step) => [step, ...(step.parallel ?? [])].map((entry) => [entry.id, describeStep(entry)] as const)));

export async function workflowStepsResponse(
  library: WorkflowLibrary,
  input: { workflowRef: string | null; workflowChosen: WorkflowChosen | null; rows: WorkflowStepRunRow[]; vars?: Record<string, string | number | boolean> | null },
): Promise<z.infer<typeof workflowStepsResponseSchema>> {
  const { workflowRef, rows } = input;
  const definition = workflowRef === null ? null : await pinnedWorkflow(library, workflowRef);
  return {
    workflowRef,
    workflowChosen: input.workflowChosen,
    outline: (definition?.steps ?? []).map((step) => ({ id: step.id, children: (step.parallel ?? []).map((child) => child.id) })),
    cleanupCount: definition?.cleanup?.length ?? 0,
    stepInfo: stepInfoOf(definition),
    blockStepIds: definition === null ? [] : definition.steps.slice(definition.attempts.start, definition.attempts.end).flatMap((step) => [step.id, ...(step.parallel ?? []).map((child) => child.id)]),
    cleanupIds: (definition?.cleanup ?? []).map((step) => step.id),
    maxAttempts: definition === null || definition.attempts.end <= definition.attempts.start ? null : (() => {
      const max = resolveAttemptsMax(definition.attempts.max, { ...definition.vars, ...(input.vars ?? {}) });
      return max.ok ? max.value : null;
    })(),
    latestVersion: library.list().find((entry) => entry.name === workflowRef?.split('@')[0])?.version ?? null,
    steps: rows
      .filter((row) => row.workflowRef === workflowRef)
      .map((row) => ({
        id: row.id,
        attemptId: row.attemptId,
        kind: stepRunKind(row.action),
        sessionRowId: row.sessionRowId,
        stepId: row.stepId,
        action: row.action,
        position: row.position,
        attempt: row.attempt,
        outcome: row.outcome,
        summary: row.summary,
        resolvedPrompt: row.resolvedPrompt,
        outputs: parseStepRunOutputs(row.outputs),
        startedAt: row.startedAt,
        endedAt: row.endedAt,
      })),
  };
}
