import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AppConfig, ModelOption } from '../config.js';
import type { WorkspaceRow } from '../db/schema.js';
import type { CriticHarnessDrive } from '../verification/critic.js';
import { defaultRoute } from './routing.js';
import { harnessConfig } from './route.js';
import { resolveClassifierSettings, resolveModelOptions, type ClassifierBackend as ClassifierBackendId } from './model-options.js';
import { costOfUsages, pricesForHarness, type Cost } from './pricing.js';
import type { AttemptUsage } from './usage.js';

export const classifierInputSchema = z.object({
  title: z.string(),
  description: z.string(),
  labels: z.array(z.string()),
  attemptNumber: z.number().int().positive(),
  previousVerdict: z.string().optional(),
  previousFailureReason: z.string().optional(),
  options: z.array(z.object({ id: z.string(), description: z.string(), harness: z.string(), model: z.string() })).min(1),
});
export type ClassifierInput = z.infer<typeof classifierInputSchema>;

export const classifierOutputSchema = z.object({
  optionId: z.string().min(1),
  reason: z.string().trim().min(1),
});
export type ClassifierOutput = z.infer<typeof classifierOutputSchema>;

export interface ClassifierBackendResult {
  output: unknown;
  /** The Harness and Model that made the call, for pricing its usage. */
  harness?: string;
  model?: string;
  usage?: AttemptUsage | null;
}

export interface ClassifierBackend {
  classify(input: ClassifierInput, ctx: { timeoutMs: number; workspace: WorkspaceRow }): Promise<ClassifierBackendResult>;
}

export interface RoutingUsage {
  usage: AttemptUsage;
  cost: Cost | null;
}

export type ClassifierOutcome =
  | { kind: 'chosen'; option: ModelOption; reason: string; routing: RoutingUsage | null }
  | { kind: 'abstained'; reason: string; routing: RoutingUsage | null };

export const DEFAULT_CLASSIFIER_INSTRUCTIONS = [
  'You route software tickets to an AI model. Choose exactly one option from the list below.',
  'Prefer the cheapest option that can plausibly finish the ticket. If this is a retry (attemptNumber above 1),',
  'use the previous verdict and failure reason to decide whether a stronger option is needed.',
  'Reply with only a JSON object: {"optionId": "<id from the options list>", "reason": "<one short line>"}.',
  'Do not use tools. Do not add any other text.',
].join('\n');

export function buildClassifierPrompt(input: ClassifierInput, instructions = DEFAULT_CLASSIFIER_INSTRUCTIONS): string {
  return `${instructions}\n\nTicket:\n${JSON.stringify(input, null, 2)}\n`;
}

function balancedObjects(text: string): string[] {
  const found: string[] = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!;
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        found.push(text.slice(start, i + 1));
        break;
      }
    }
  }
  return found;
}

/** The first JSON object in the reply that carries an `optionId`, else the first that parses; the reply may wrap it in prose or a code fence. */
function extractJson(text: string): unknown {
  const parsed: unknown[] = [];
  for (const candidate of balancedObjects(text)) {
    try {
      parsed.push(JSON.parse(candidate));
    } catch {
      continue;
    }
  }
  const chosen = parsed.find((value) => typeof value === 'object' && value !== null && 'optionId' in value) ?? parsed[0];
  if (chosen === undefined) throw new Error('no JSON object in the reply');
  return chosen;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function usageToPriced(result: ClassifierBackendResult, config: Pick<AppConfig, 'harnesses'>): RoutingUsage | null {
  if (!result.usage) return null;
  const harness = result.harness ? harnessConfig(config, result.harness) : undefined;
  return { usage: result.usage, cost: harness ? costOfUsages([result.usage], pricesForHarness(harness)) : null };
}

export async function runClassifier(
  backend: ClassifierBackend,
  input: ClassifierInput,
  ctx: { timeoutMs: number; workspace: WorkspaceRow; config: Pick<AppConfig, 'harnesses'> },
  options: readonly ModelOption[],
): Promise<ClassifierOutcome> {
  let result: ClassifierBackendResult;
  try {
    result = await withTimeout(backend.classify(input, { timeoutMs: ctx.timeoutMs, workspace: ctx.workspace }), ctx.timeoutMs);
  } catch (error) {
    return { kind: 'abstained', reason: error instanceof Error ? error.message : String(error), routing: null };
  }
  const routing = usageToPriced(result, ctx.config);
  const parsed = classifierOutputSchema.safeParse(result.output);
  if (!parsed.success) return { kind: 'abstained', reason: 'invalid output: expected {optionId, reason}', routing };
  const option = options.find((o) => o.id === parsed.data.optionId);
  if (!option) return { kind: 'abstained', reason: `invalid output: option '${parsed.data.optionId}' is not in the list`, routing };
  return { kind: 'chosen', option, reason: parsed.data.reason, routing };
}

export function createHarnessClassifierBackend(deps: {
  drive: CriticHarnessDrive;
  getConfig: () => AppConfig;
  instructions?: () => string;
}): ClassifierBackend {
  return {
    async classify(input, { timeoutMs, workspace }) {
      const config = deps.getConfig();
      const { harness: harnessId, model } = defaultRoute(config, workspace, null);
      const harness = harnessConfig(config, harnessId);
      if (!harness) throw new Error(`Harness '${harnessId}' is not configured`);
      const cwd = await mkdtemp(join(tmpdir(), 'harmonic-route-classifier-'));
      try {
        const driven = await deps.drive.run({
          harness,
          harnessId,
          model,
          cwd,
          prompt: buildClassifierPrompt(input, deps.instructions?.()),
          timeoutMs,
          denyPermissions: true,
        });
        return {
          output: extractJson(driven.output),
          harness: harnessId,
          model,
          usage: acpUsage(driven.usage, model),
        };
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}

function acpUsage(usage: Record<string, unknown> | undefined, model: string): AttemptUsage | null {
  if (!usage) return null;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const tokens = {
    inputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    cacheReadTokens: num(usage.cachedReadTokens ?? usage.cacheReadTokens),
    cacheWriteTokens: num(usage.cachedWriteTokens ?? usage.cacheWriteTokens),
  };
  return {
    models: { [model]: tokens },
    totals: { ...tokens, totalTokens: typeof usage.totalTokens === 'number' ? usage.totalTokens : null },
    toolCalls: {},
    source: 'acp',
  };
}

export interface ClassifyRequest {
  workspace: WorkspaceRow;
  title: string;
  description: string;
  labels: readonly string[];
  attemptNumber: number;
  previousVerdict?: string | undefined;
  previousFailureReason?: string | undefined;
}

export class RouteClassifier {
  constructor(
    private readonly getConfig: () => AppConfig,
    private readonly backends: Partial<Record<ClassifierBackendId, ClassifierBackend>>,
  ) {}

  isEnabled(workspace: WorkspaceRow): boolean {
    return resolveClassifierSettings(workspace).enabled;
  }

  async classify(request: ClassifyRequest): Promise<ClassifierOutcome> {
    const config = this.getConfig();
    const settings = resolveClassifierSettings(request.workspace);
    const options = resolveModelOptions(request.workspace, config);
    if (options.length === 0) return { kind: 'abstained', reason: 'no Model Options are configured', routing: null };
    const backend = this.backends[settings.backend];
    if (!backend) return { kind: 'abstained', reason: `the ${settings.backend} backend is not available`, routing: null };
    const input = classifierInputSchema.parse({
      title: request.title,
      description: request.description,
      labels: [...request.labels],
      attemptNumber: request.attemptNumber,
      ...(request.previousVerdict === undefined ? {} : { previousVerdict: request.previousVerdict }),
      ...(request.previousFailureReason === undefined ? {} : { previousFailureReason: request.previousFailureReason }),
      options: options.map(({ id, description, harness, model }) => ({ id, description, harness, model })),
    });
    return runClassifier(backend, input, { timeoutMs: settings.timeoutSeconds * 1000, workspace: request.workspace, config }, options);
  }
}
