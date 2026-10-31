import { LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import { DomainError, type ErrorIssue } from './errors.js';
import { conditionBody, ExpressionError, findInterpolations, parseExpression, type ExpressionRef } from './workflow-expression.js';

export const WORKFLOW_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const VAR_NAME_PATTERN = /^[a-z][a-zA-Z0-9_-]{0,63}$/;

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
    vars: z.record(z.string().regex(VAR_NAME_PATTERN, 'a var name starts with a lowercase letter and holds letters, digits, - or _'), z.union([z.string(), z.number(), z.boolean()])).optional(),
    steps: z.array(z.unknown()).min(1, 'a workflow needs at least one step'),
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

export const MAX_ATTEMPTS_LIMIT = 20;

export interface AttemptsBlock {
  /** The literal number, or the `${{ vars.NAME }}` text resolved against the vars at run time. */
  readonly max: string | number;
  /** The block's steps are `steps.slice(start, end)`. */
  readonly start: number;
  readonly end: number;
}

export interface WorkflowDefinition {
  readonly name: string;
  readonly description: string;
  /** Every step in execution order, the `attempts:` block's steps included. */
  readonly steps: readonly WorkflowStepDefinition[];
  readonly attempts: AttemptsBlock;
  readonly cleanup?: readonly WorkflowStepDefinition[] | undefined;
  readonly vars: Readonly<Record<string, string | number | boolean>>;
}

/** Parses and validates workflow YAML, throwing a `validation` DomainError whose issues carry 1-based line and column. */
/** `lenient` skips the `with:` key rules added after workflows were first stored, so a saved or pinned workflow keeps running. */
export function parseWorkflow(text: string, options: { lenient?: boolean } = {}): WorkflowDefinition {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const at = (offset: number): { line: number; column: number } => {
    const pos = lineCounter.linePos(offset);
    return { line: pos.line, column: pos.col };
  };
  const issues: ErrorIssue[] = doc.errors.map((e) => ({ message: e.message.split('\n')[0]!, ...at(e.pos[0]) }));
  if (issues.length === 0) {
    const parsed = workflowSchema.safeParse(doc.toJS());
    const shaped = parsed.success ? layout(parsed.data) : undefined;
    const invariants: Problem[] = parsed.success && shaped ? [...shaped.problems, ...stepInvariants(shaped.located, parsed.data, options.lenient === true), ...expressionProblems(shaped.located, parsed.data, doc, text)] : [];
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
  const { located, block } = layout(definition);
  return { name: definition.name, description: definition.description, cleanup: definition.cleanup, vars: definition.vars ?? {}, steps: located.map((l) => l.step), attempts: block! };
}

/** Checks every `option:` code against `isUsable`. */
export async function optionCodeProblems(text: string, isUsable: (code: string) => boolean | Promise<boolean>): Promise<void> {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const found: { path: PropertyKey[]; code: string }[] = [];
  const walk = (node: unknown, path: PropertyKey[]): void => {
    if (Array.isArray(node)) node.forEach((child, i) => walk(child, [...path, i]));
    else if (isRecord(node)) {
      const withBlock = node.with;
      if ((node.uses === 'agent' || node.uses === 'critic') && isRecord(withBlock) && typeof withBlock.option === 'string') found.push({ path: [...path, 'with', 'option'], code: withBlock.option });
      for (const [key, child] of Object.entries(node)) walk(child, [...path, key]);
    }
  };
  walk(doc.toJS(), []);
  const issues: ErrorIssue[] = [];
  for (const { path, code } of found) {
    if (await isUsable(code)) continue;
    const node = doc.getIn(path, true) as { range?: [number, number, number] | null } | undefined;
    const pos = lineCounter.linePos(node?.range?.[0] ?? 0);
    issues.push({ message: `model option '${code}' is not defined, or is disabled, in the global list and every Workspace`, line: pos.line, column: pos.col });
  }
  if (issues.length > 0) throw new DomainError('validation', `workflow refused: ${issues.map((i) => `${i.line}:${i.column} ${i.message}`).join('; ')}`, issues);
}

interface Located {
  step: WorkflowStepDefinition;
  path: PropertyKey[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const MAX_RULE = `a whole number from 1 to ${MAX_ATTEMPTS_LIMIT}`;
const MAX_VAR = /^vars\.([a-z][a-zA-Z0-9_-]*)$/;

export function resolveAttemptsMax(max: string | number, vars: Readonly<Record<string, string | number | boolean>>): { ok: true; value: number } | { ok: false; message: string } {
  let value: unknown = max;
  if (typeof max === 'string') {
    const spans = findInterpolations(max);
    const name = spans.length === 1 && max.trim() === max.slice(spans[0]!.start, spans[0]!.end) ? MAX_VAR.exec(spans[0]!.source)?.[1] : undefined;
    if (name === undefined) return { ok: false, message: `attempts.max must be ${MAX_RULE} or a single \${{ vars.NAME }}` };
    value = vars[name];
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value);
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_ATTEMPTS_LIMIT) return { ok: false, message: `attempts.max var ${name} must be ${MAX_RULE}, not ${String(value ?? 'unset')}` };
    return { ok: true, value: value as number };
  }
  if (!Number.isInteger(value) || max < 1 || max > MAX_ATTEMPTS_LIMIT) return { ok: false, message: `attempts.max must be ${MAX_RULE}, not ${String(max)}` };
  return { ok: true, value: max };
}

function layout(wf: z.infer<typeof workflowSchema>): { located: Located[]; block: AttemptsBlock | undefined; problems: Problem[] } {
  const problems: Problem[] = [];
  const located: Located[] = [];
  const blocks: number[] = [];
  let block: AttemptsBlock | undefined;
  const addStep = (raw: unknown, path: PropertyKey[]): void => {
    if (isRecord(raw) && 'attempts' in raw) {
      problems.push({ path: [...path, 'attempts'], message: 'attempts: blocks cannot be nested', key: true });
      return;
    }
    const parsed = stepSchema.safeParse(raw);
    if (parsed.success) located.push({ step: parsed.data, path });
    else problems.push(...stepProblems(parsed.error.issues, path));
  };
  wf.steps.forEach((raw, i) => {
    const path: PropertyKey[] = ['steps', i];
    if (!isRecord(raw) || !('attempts' in raw)) return addStep(raw, path);
    blocks.push(i);
    if (blocks.length > 1) return;
    const extra = Object.keys(raw).filter((k) => k !== 'attempts');
    for (const key of extra) problems.push({ path: [...path, key], message: `unknown key: ${key}`, key: true });
    const body = raw.attempts;
    if (!isRecord(body)) {
      problems.push({ path: [...path, 'attempts'], message: 'attempts needs max and steps' });
      return;
    }
    for (const key of Object.keys(body).filter((k) => k !== 'max' && k !== 'steps')) problems.push({ path: [...path, 'attempts', key], message: `unknown key: ${key}`, key: true });
    const max = body.max;
    const inner = body.steps;
    if (typeof max !== 'number' && typeof max !== 'string') problems.push({ path: [...path, 'attempts', 'max'], message: `attempts.max must be ${MAX_RULE} or a single \${{ vars.NAME }}` });
    else {
      const resolved = resolveAttemptsMax(max, wf.vars ?? {});
      if (!resolved.ok) problems.push({ path: [...path, 'attempts', 'max'], message: resolved.message });
    }
    if (!Array.isArray(inner) || inner.length === 0) {
      problems.push({ path: [...path, 'attempts', 'steps'], message: 'an attempts: block needs at least one step' });
      return;
    }
    const start = located.length;
    inner.forEach((entry, j) => addStep(entry, [...path, 'attempts', 'steps', j]));
    if (typeof max === 'number' || typeof max === 'string') block = { max, start, end: located.length };
  });
  if (blocks.length === 0) problems.push({ path: ['steps'], message: 'a workflow needs exactly one attempts: block, found none' });
  if (blocks.length > 1) problems.push({ path: ['steps', blocks[1]!], message: `a workflow needs exactly one attempts: block, found ${blocks.length}` });
  return { located, block, problems };
}

function stepProblems(issues: z.core.$ZodIssue[], path: PropertyKey[]): Problem[] {
  return issues.flatMap((i): Problem[] => (i.code === 'unrecognized_keys' ? i.keys.map((k) => ({ path: [...path, ...i.path, k], message: `unknown key: ${k}`, key: true })) : [{ path: [...path, ...i.path], message: i.message }]));
}

const agentWithSchema = z
  .object({
    prompt: z.string().min(1).optional(),
    option: z.string().min(1).optional(),
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
    option: z.string().min(1).optional(),
    harness: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.option !== undefined) return;
    if (value.harness === undefined) ctx.addIssue({ code: 'custom', path: ['harness'], message: 'a critic needs its own harness (or an option)' });
    if (value.model === undefined) ctx.addIssue({ code: 'custom', path: ['model'], message: 'a critic needs its own model (or an option)' });
  });

export type CriticStepWith = z.infer<typeof criticWithSchema>;

export function criticStepWith(input: unknown): CriticStepWith | null {
  const parsed = criticWithSchema.safeParse(input ?? {});
  return parsed.success ? parsed.data : null;
}

const emptyWithSchema = z.object({}).strict();
const postMergeCheckWithSchema = z.object({ run: z.string().min(1).optional() }).strict();
const EMPTY_WITH_ACTIONS: ReadonlySet<string> = new Set(['verify', 'rebase', 'merge', 'cleanup', 'artifact']);

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

function allLocated(located: Located[], wf: z.infer<typeof workflowSchema>): Located[] {
  return [...located, ...(wf.cleanup ?? []).map((step, i) => ({ step, path: ['cleanup', i] as PropertyKey[] }))];
}

function stepInvariants(located: Located[], wf: z.infer<typeof workflowSchema>, lenient: boolean): Problem[] {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  const check = (step: WorkflowStepDefinition, path: PropertyKey[], group?: string): void => {
    if (seen.has(step.id)) problems.push({ path: [...path, 'id'], message: `duplicate step id: ${step.id}` });
    seen.add(step.id);
    const forms = [step.run, step.uses, step.parallel].filter((form) => form !== undefined).length;
    if (forms !== 1) problems.push({ path, message: `step ${step.id} needs exactly one of run, uses or parallel` });
    if (step.with !== undefined && step.uses === undefined) problems.push({ path: [...path, 'with'], message: 'with is only valid beside uses' });
    if (step.uses === 'agent') problems.push(...withProblems(path, agentWithSchema, step.with));
    if (group !== undefined && step.uses !== undefined && !PARALLEL_ACTIONS.has(step.uses)) problems.push({ path: [...path, 'uses'], message: `${step.uses} cannot run inside parallel group ${group}: only critic and command steps run together` });
    if (step.uses === 'critic') problems.push(...withProblems(path, criticWithSchema, step.with));
    if (!lenient && step.uses === 'post-merge-check') problems.push(...withProblems(path, postMergeCheckWithSchema, step.with));
    if (!lenient && step.uses !== undefined && EMPTY_WITH_ACTIONS.has(step.uses)) problems.push(...withProblems(path, emptyWithSchema, step.with));
    if ((step.uses === 'agent' || step.uses === 'critic') && step.with?.option !== undefined) {
      for (const key of ['harness', 'model']) if (step.with[key] !== undefined) problems.push({ path: [...path, 'with', key], message: `with.option cannot be combined with with.${key}: an option names its own harness and model`, key: true });
    }
  };
  for (const { step, path } of allLocated(located, wf)) {
    check(step, path);
    step.parallel?.forEach((child, j) => check(child, [...path, 'parallel', j], step.id));
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

const TICKET_FIELDS = ['title', 'body', 'labels', 'ref', 'origin'];
const ATTEMPT_FIELDS = ['number', 'previousVerdict', 'failureReason'];
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

function expressionProblems(located: Located[], wf: z.infer<typeof workflowSchema>, doc: ReturnType<typeof parseDocument>, text: string): Problem[] {
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
  const checkStep = (step: WorkflowStepDefinition, path: PropertyKey[]): void => {
    if (step.if !== undefined) check([...path, 'if'], conditionBody(step.if).source);
    if (step.run !== undefined) checkText([...path, 'run'], step.run);
    for (const [key, value] of Object.entries(step.with ?? {})) if (typeof value === 'string') checkText([...path, 'with', key], value);
  };
  for (const { step, path } of allLocated(located, wf)) {
    checkStep(step, path);
    step.parallel?.forEach((child, j) => checkStep(child, [...path, 'parallel', j]));
    for (const child of step.parallel ?? []) earlier.add(child.id);
    earlier.add(step.id);
  }
  return problems;
}
