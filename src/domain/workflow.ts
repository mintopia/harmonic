import { LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import { DomainError, type ErrorIssue } from './errors.js';

export const WORKFLOW_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export const WORKFLOW_ACTIONS = ['rebase', 'agent', 'verify', 'command', 'critic', 'merge', 'open-pr', 'artifact', 'post-merge-check', 'close', 'tracker-comment', 'cleanup'] as const;

const stepSchema = z
  .object({
    id: z.string().regex(WORKFLOW_NAME_PATTERN, 'a step id starts with a lowercase letter and holds lowercase letters, digits, - or _'),
    run: z.string().min(1).optional(),
    uses: z.enum(WORKFLOW_ACTIONS).optional(),
    with: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const workflowSchema = z
  .object({
    name: z.string().regex(WORKFLOW_NAME_PATTERN, 'a name starts with a lowercase letter and holds lowercase letters, digits, - or _ (max 64)'),
    description: z.string(),
    steps: z.array(stepSchema).min(1, 'a workflow needs at least one step'),
  })
  .strict();

interface Problem {
  path: PropertyKey[];
  message: string;
  key?: true;
}

export interface WorkflowDefinition {
  readonly name: string;
  readonly description: string;
  readonly steps: readonly { id: string; run?: string | undefined; uses?: (typeof WORKFLOW_ACTIONS)[number] | undefined; with?: Record<string, unknown> | undefined }[];
}

/** Parses and validates workflow YAML, throwing a `validation` DomainError whose issues carry 1-based line and column. */
export function parseWorkflow(text: string): WorkflowDefinition {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const at = (offset: number): { line: number; column: number } => {
    const pos = lineCounter.linePos(offset);
    return { line: pos.line, column: pos.col };
  };
  const issues: ErrorIssue[] = doc.errors.map((e) => ({ message: e.message.split('\n')[0]!, ...at(e.pos[0]) }));
  if (issues.length === 0) {
    const parsed = workflowSchema.safeParse(doc.toJS());
    const invariants: Problem[] = parsed.success ? stepInvariants(parsed.data) : [];
    const problems: Problem[] = parsed.success ? invariants : parsed.error.issues.flatMap((i): Problem[] => (i.code === 'unrecognized_keys' ? i.keys.map((k) => ({ path: [...i.path, k], message: `unknown key: ${k}`, key: true })) : [{ path: i.path, message: i.message }]));
    for (const problem of problems) {
      const node = problem.key ? keyOffset(doc, problem.path) : nearestNode(doc, problem.path);
      issues.push({ message: problem.message, ...at(node ?? 0) });
    }
  }
  if (issues.length > 0) {
    throw new DomainError('validation', `workflow refused: ${issues.map((i) => `${i.line}:${i.column} ${i.message}`).join('; ')}`, issues);
  }
  return workflowSchema.parse(doc.toJS()) as WorkflowDefinition;
}

const agentWithSchema = z
  .object({
    prompt: z.string().min(1).optional(),
    harness: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    continueAttempts: z.number().int().min(0).optional(),
    continuePrompt: z.string().min(1).optional(),
  })
  .strict();

export type AgentStepWith = z.infer<typeof agentWithSchema>;

export function agentStepWith(input: unknown): AgentStepWith | null {
  const parsed = agentWithSchema.safeParse(input ?? {});
  return parsed.success ? parsed.data : null;
}

function stepInvariants(wf: z.infer<typeof workflowSchema>): Problem[] {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  wf.steps.forEach((step, i) => {
    if (seen.has(step.id)) problems.push({ path: ['steps', i, 'id'], message: `duplicate step id: ${step.id}` });
    seen.add(step.id);
    if ((step.run === undefined) === (step.uses === undefined)) problems.push({ path: ['steps', i], message: `step ${step.id} needs exactly one of run or uses` });
    if (step.with !== undefined && step.uses === undefined) problems.push({ path: ['steps', i, 'with'], message: 'with is only valid beside uses' });
    if (step.uses === 'agent') {
      const parsed = agentWithSchema.safeParse(step.with ?? {});
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          if (issue.code === 'unrecognized_keys') for (const key of issue.keys) problems.push({ path: ['steps', i, 'with', key], message: `unknown key: ${key}`, key: true });
          else problems.push({ path: ['steps', i, 'with', ...issue.path], message: `with.${issue.path.join('.')}: ${issue.message}` });
        }
      }
    }
  });
  return problems;
}

function nearestNode(doc: ReturnType<typeof parseDocument>, path: PropertyKey[]): number | undefined {
  const keys = path.map((p) => (typeof p === 'symbol' ? String(p) : p));
  for (let n = keys.length; n >= 0; n--) {
    const node = doc.getIn(keys.slice(0, n), true) as { range?: [number, number, number] | null } | undefined;
    if (node?.range) return node.range[0];
  }
  return undefined;
}

function keyOffset(doc: ReturnType<typeof parseDocument>, path: PropertyKey[]): number | undefined {
  const keys = path.map((p) => (typeof p === 'symbol' ? String(p) : p));
  const parent = doc.getIn(keys.slice(0, -1), true) as { items?: { key?: { value?: unknown; range?: [number, number, number] | null } }[] } | undefined;
  return parent?.items?.find((pair) => pair.key?.value === keys.at(-1))?.key?.range?.[0];
}
