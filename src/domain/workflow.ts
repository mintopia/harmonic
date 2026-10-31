import { LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import { DomainError, type ErrorIssue } from './errors.js';
import { conditionBody, ExpressionError, findInterpolations, parseExpression, type ExpressionRef } from './workflow-expression.js';

export const WORKFLOW_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export const WORKFLOW_ACTIONS = ['rebase', 'agent', 'verify', 'command', 'critic', 'merge', 'open-pr', 'artifact', 'post-merge-check', 'close-ticket', 'comment', 'cleanup'] as const;

const stepIdSchema = z.string().regex(WORKFLOW_NAME_PATTERN, 'a step id starts with a lowercase letter and holds lowercase letters, digits, - or _');

const leafStepSchema = z
  .object({
    id: stepIdSchema,
    run: z.string().min(1).optional(),
    uses: z.enum(WORKFLOW_ACTIONS).optional(),
    with: z.record(z.string(), z.unknown()).optional(),
    if: z.string().min(1).optional(),
  })
  .strict();

const stepSchema = leafStepSchema.extend({ parallel: z.array(leafStepSchema).min(1, 'a parallel group needs at least one step').optional() }).strict();

const workflowSchema = z
  .object({
    name: z.string().regex(WORKFLOW_NAME_PATTERN, 'a name starts with a lowercase letter and holds lowercase letters, digits, - or _ (max 64)'),
    description: z.string(),
    vars: z.record(z.string().regex(WORKFLOW_NAME_PATTERN, 'a var name starts with a lowercase letter and holds lowercase letters, digits, - or _'), z.union([z.string(), z.number(), z.boolean()])).optional(),
    steps: z.array(stepSchema).min(1, 'a workflow needs at least one step'),
    cleanup: z.array(stepSchema).optional(),
  })
  .strict();

interface Problem {
  path: PropertyKey[];
  message: string;
  key?: true;
  offset?: number;
}

export interface WorkflowStepDefinition {
  id: string;
  run?: string | undefined;
  uses?: (typeof WORKFLOW_ACTIONS)[number] | undefined;
  with?: Record<string, unknown> | undefined;
  if?: string | undefined;
  parallel?: readonly WorkflowStepDefinition[] | undefined;
}

export interface WorkflowDefinition {
  readonly name: string;
  readonly description: string;
  readonly steps: readonly WorkflowStepDefinition[];
  readonly cleanup?: readonly WorkflowStepDefinition[] | undefined;
  readonly vars: Readonly<Record<string, string | number | boolean>>;
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
    const invariants: Problem[] = parsed.success ? [...stepInvariants(parsed.data), ...expressionProblems(parsed.data, doc, text)] : [];
    const problems: Problem[] = parsed.success ? invariants : parsed.error.issues.flatMap((i): Problem[] => (i.code === 'unrecognized_keys' ? i.keys.map((k) => ({ path: [...i.path, k], message: `unknown key: ${k}`, key: true })) : [{ path: i.path, message: i.message }]));
    for (const problem of problems) {
      const node = problem.offset ?? (problem.key ? keyOffset(doc, problem.path) : nearestNode(doc, problem.path));
      issues.push({ message: problem.message, ...at(node ?? 0) });
    }
  }
  if (issues.length > 0) {
    throw new DomainError('validation', `workflow refused: ${issues.map((i) => `${i.line}:${i.column} ${i.message}`).join('; ')}`, issues);
  }
  const definition = workflowSchema.parse(doc.toJS());
  return { ...definition, vars: definition.vars ?? {} } as WorkflowDefinition;
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

const criticWithSchema = z
  .object({
    prompt: z.string('a critic needs its own prompt').min(1),
    harness: z.string('a critic needs its own harness').min(1),
    model: z.string('a critic needs its own model').min(1),
  })
  .strict();

export type CriticStepWith = z.infer<typeof criticWithSchema>;

export function criticStepWith(input: unknown): CriticStepWith | null {
  const parsed = criticWithSchema.safeParse(input ?? {});
  return parsed.success ? parsed.data : null;
}

function withProblems(path: PropertyKey[], schema: z.ZodType, input: unknown): Problem[] {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return [];
  return parsed.error.issues.flatMap((issue): Problem[] =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => ({ path: [...path, 'with', key], message: `unknown key: ${key}`, key: true }))
      : [{ path: [...path, 'with', ...issue.path], message: `with.${issue.path.join('.')}: ${issue.message}` }],
  );
}

const PARALLEL_ACTIONS: ReadonlySet<string> = new Set(['critic', 'command']);

function stepInvariants(wf: z.infer<typeof workflowSchema>): Problem[] {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const check = (step: z.infer<typeof leafStepSchema> & { parallel?: unknown }, path: PropertyKey[], group?: string): void => {
    if (seen.has(step.id)) problems.push({ path: [...path, 'id'], message: `duplicate step id: ${step.id}` });
    seen.add(step.id);
    const forms = [step.run, step.uses, step.parallel].filter((form) => form !== undefined).length;
    if (forms !== 1) problems.push({ path, message: `step ${step.id} needs exactly one of run, uses or parallel` });
    if (step.with !== undefined && step.uses === undefined) problems.push({ path: [...path, 'with'], message: 'with is only valid beside uses' });
    if (step.uses === 'agent') problems.push(...withProblems(path, agentWithSchema, step.with));
    if (group !== undefined && step.uses !== undefined && !PARALLEL_ACTIONS.has(step.uses)) problems.push({ path: [...path, 'uses'], message: `${step.uses} cannot run inside parallel group ${group}: only critic and command steps run together` });
    if (step.uses === 'critic') problems.push(...withProblems(path, criticWithSchema, step.with));
  };
  for (const list of ['steps', 'cleanup'] as const) {
    (wf[list] ?? []).forEach((step, i) => {
      check(step, [list, i]);
      step.parallel?.forEach((child, j) => check(child, [list, i, 'parallel', j], step.id));
    });
  }
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

const TICKET_FIELDS = ['title', 'body', 'labels', 'ref'];
const ATTEMPT_FIELDS = ['number', 'failureReason'];
const WORKSPACE_FIELDS = ['id', 'name'];

function badReference(ref: string[], earlier: Set<string>, declared: Set<string>): string | undefined {
  const [root, name, field, sub] = ref;
  const known = (fields: string[]): string | undefined => (name !== undefined && fields.includes(name) && ref.length === 2 ? undefined : `unknown reference ${ref.join('.')}`);
  if (root === 'ticket') return known(TICKET_FIELDS);
  if (root === 'attempt') return known(ATTEMPT_FIELDS);
  if (root === 'workspace') return known(WORKSPACE_FIELDS);
  if (root === 'vars') return name !== undefined && declared.has(name) && ref.length === 2 ? undefined : `unknown var ${name ?? ''}`.trim();
  if (root === 'secrets') return name !== undefined && ref.length === 2 ? undefined : 'secrets needs a name: secrets.NAME';
  if (root !== 'steps') return `unknown reference ${ref.join('.')}`;
  if (name === undefined || !earlier.has(name)) return `steps.${name ?? ''} is not an earlier step`;
  if (field !== 'outcome' && field !== 'outputs') return `steps.${name} has outcome and outputs, not ${field ?? ''}`.trimEnd();
  if (field === 'outcome' && ref.length > 3) return `unknown reference ${ref.join('.')}`;
  if (field === 'outputs' && (ref.length > 4 || (sub !== undefined && sub !== 'stdout' && sub !== 'exitCode'))) return `unknown reference ${ref.join('.')}`;
  return undefined;
}

function expressionProblems(wf: z.infer<typeof workflowSchema>, doc: ReturnType<typeof parseDocument>, text: string): Problem[] {
  const problems: Problem[] = [];
  const declared = new Set(Object.keys(wf.vars ?? {}));
  const earlier = new Set<string>();
  const check = (path: PropertyKey[], source: string): void => {
    const nodeStart = nearestNode(doc, path) ?? 0;
    const origin = Math.max(text.indexOf(source, nodeStart), nodeStart);
    const at = (offset: number): number => origin + offset;
    let refs: ExpressionRef[];
    try {
      refs = parseExpression(source).refs;
    } catch (error) {
      if (!(error instanceof ExpressionError)) throw error;
      problems.push({ path, message: `invalid expression: ${error.message}`, offset: at(error.offset) });
      return;
    }
    for (const ref of refs) {
      const message = badReference(ref.path, earlier, declared);
      if (message !== undefined) problems.push({ path, message, offset: at(ref.offset) });
    }
  };
  const checkText = (path: PropertyKey[], value: string): void => {
    for (const span of findInterpolations(value)) check(path, span.source);
  };
  const checkStep = (step: z.infer<typeof leafStepSchema>, path: PropertyKey[]): void => {
    if (step.if !== undefined) check([...path, 'if'], conditionBody(step.if).source);
    if (step.run !== undefined) checkText([...path, 'run'], step.run);
    for (const [key, value] of Object.entries(step.with ?? {})) if (typeof value === 'string') checkText([...path, 'with', key], value);
  };
  for (const [list, steps] of [['steps', wf.steps], ['cleanup', wf.cleanup ?? []]] as const) {
    steps.forEach((step, i) => {
      checkStep(step, [list, i]);
      step.parallel?.forEach((child, j) => checkStep(child, [list, i, 'parallel', j]));
      for (const child of step.parallel ?? []) earlier.add(child.id);
      earlier.add(step.id);
    });
  }
  return problems;
}
