import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { AppConfig, ModelOption } from '../config.js';
import type { WorkspaceRow } from '../db/schema.js';
import type { CriticHarnessDrive } from '../verification/critic.js';
import { defaultRoute } from './routing.js';
import { buildClassifierPrompt } from '../execution/prompt-assembly.js';
import { resolvePromptFragments } from './setting-override.js';
import { harnessConfig } from './route.js';
import { parseClassifierEndpoint, resolveClassifierSettings, resolveModelOptions, type ModelOptionOverride, type ClassifierBackend as ClassifierBackendId } from './model-options.js';
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
  /** Spend the backend reported itself, used instead of pricing the usage from a Harness catalog. */
  costUsd?: number;
}

export interface ClassifierBackend {
  classify(input: ClassifierInput, ctx: { timeoutMs: number; workspace: WorkspaceRow; prompt: string }): Promise<ClassifierBackendResult>;
}

export interface RoutingUsage {
  usage: AttemptUsage;
  cost: Cost | null;
}

export type ClassifierOutcome =
  | { kind: 'chosen'; option: ModelOption; position: number; optionCount: number; reason: string; routing: RoutingUsage | null; prompt?: string }
  | { kind: 'abstained'; reason: string; routing: RoutingUsage | null; prompt?: string };

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
  if (result.costUsd !== undefined) {
    const byModel = result.model ? { [result.model]: result.costUsd } : {};
    return { usage: result.usage, cost: { totalUsd: result.costUsd, byModel, incomplete: false } };
  }
  const harness = result.harness ? harnessConfig(config, result.harness) : undefined;
  return { usage: result.usage, cost: harness ? costOfUsages([result.usage], pricesForHarness(harness)) : null };
}

export async function runClassifier(
  backend: ClassifierBackend,
  input: ClassifierInput,
  ctx: { timeoutMs: number; workspace: WorkspaceRow; config: Pick<AppConfig, 'harnesses'>; prompt: string },
  options: readonly ModelOption[],
): Promise<ClassifierOutcome> {
  let result: ClassifierBackendResult;
  try {
    result = await withTimeout(backend.classify(input, { timeoutMs: ctx.timeoutMs, workspace: ctx.workspace, prompt: ctx.prompt }), ctx.timeoutMs);
  } catch (error) {
    return { kind: 'abstained', reason: error instanceof Error ? error.message : String(error), routing: null, prompt: ctx.prompt };
  }
  const routing = usageToPriced(result, ctx.config);
  const parsed = classifierOutputSchema.safeParse(result.output);
  if (!parsed.success) return { kind: 'abstained', reason: 'invalid output: expected {optionId, reason}', routing, prompt: ctx.prompt };
  const option = options.find((o) => o.id === parsed.data.optionId);
  if (!option) return { kind: 'abstained', reason: `invalid output: option '${parsed.data.optionId}' is not in the list`, routing, prompt: ctx.prompt };
  return { kind: 'chosen', option, position: options.indexOf(option) + 1, optionCount: options.length, reason: parsed.data.reason, routing, prompt: ctx.prompt };
}

export function createHarnessClassifierBackend(deps: {
  drive: CriticHarnessDrive;
  getConfig: () => AppConfig;
}): ClassifierBackend {
  return {
    async classify(_input, { timeoutMs, workspace, prompt }) {
      const config = deps.getConfig();
      const settings = resolveClassifierSettings(workspace);
      const { harness: harnessId, model } = settings.harness
        ? { harness: settings.harness, model: settings.model ?? harnessConfig(config, settings.harness)?.defaultModel ?? '' }
        : defaultRoute(config, workspace, null);
      const harness = harnessConfig(config, harnessId);
      if (!harness) throw new Error(`Harness '${harnessId}' is not configured`);
      const cwd = await mkdtemp(join(tmpdir(), 'harmonic-route-classifier-'));
      try {
        const driven = await deps.drive.run({
          harness,
          harnessId,
          model,
          cwd,
          prompt,
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

export function createOpenAiCompatibleClassifierBackend(deps: {
  reveal: (workspaceId: number, name: string) => Promise<string | null>;
  fetch?: typeof fetch;
}): ClassifierBackend {
  const doFetch = deps.fetch ?? fetch;
  return {
    async classify(input, { timeoutMs, workspace, prompt }) {
      const endpoint = parseClassifierEndpoint(workspace.classifierEndpoint);
      if (!endpoint) throw new Error('no OpenAI-compatible endpoint is configured for this Workspace');
      const apiKey = await deps.reveal(workspace.id, endpoint.apiKeySecret);
      if (apiKey === null) throw new Error(`Secret '${endpoint.apiKeySecret}' is not set for this Workspace`);
      const response = await doFetch(`${endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: endpoint.model,
          messages: [{ role: 'user', content: prompt }],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'route_decision',
              strict: true,
              schema: {
                type: 'object',
                properties: { optionId: { type: 'string', enum: input.options.map((o) => o.id) }, reason: { type: 'string' } },
                required: ['optionId', 'reason'],
                additionalProperties: false,
              },
            },
          },
        }),
      });
      if (!response.ok) throw new Error(`the endpoint answered HTTP ${response.status}`);
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('the endpoint reply carried no message content');
      let output: unknown;
      try {
        output = JSON.parse(content);
      } catch {
        throw new Error('the endpoint reply was not valid JSON');
      }
      const usage = body.usage
        ? acpUsage({ inputTokens: body.usage.prompt_tokens, outputTokens: body.usage.completion_tokens, totalTokens: body.usage.total_tokens }, endpoint.model)
        : null;
      return { output, usage };
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
  modelOptionOverrides?: readonly ModelOptionOverride[] | null | undefined;
}

export type WorkflowClassifierOutcome =
  | { kind: 'chosen'; name: string; reason: string; routing: RoutingUsage | null; prompt: string }
  | { kind: 'abstained'; reason: string; routing: RoutingUsage | null; prompt?: string };

export interface ClassifyWorkflowRequest {
  workspace: WorkspaceRow;
  title: string;
  description: string;
  labels: readonly string[];
  workflows: ReadonlyArray<{ name: string; description: string }>;
}

function buildWorkflowClassifierPrompt(input: ClassifierInput): string {
  const { options, ...ticket } = input;
  return [
    'Choose the workflow that should run this Ticket. Pick exactly one workflow from the list, by its name.',
    'Reply with only a JSON object: {"optionId": "<workflow name>", "reason": "<one line why it fits>"}.',
    `Workflows:\n${options.map((o) => `- ${o.id}: ${o.description}`).join('\n')}`,
    `Ticket:\n${JSON.stringify(ticket, null, 2)}`,
  ].join('\n\n');
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
    const options = resolveModelOptions(request.workspace, config, request.modelOptionOverrides);
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
    return runClassifier(backend, input, {
      timeoutMs: settings.timeoutSeconds * 1000,
      workspace: request.workspace,
      config,
      prompt: buildClassifierPrompt(input, resolvePromptFragments(request.workspace, config)),
    }, options);
  }

  isWorkflowClassifierEnabled(workspace: WorkspaceRow): boolean {
    return workspace.workflowClassifierEnabled ?? false;
  }

  /** Picks a workflow by name from `workflows` using the Workspace's Route Classifier backend; abstains on any failure. */
  async classifyWorkflow(request: ClassifyWorkflowRequest): Promise<WorkflowClassifierOutcome> {
    if (request.workflows.length === 0) return { kind: 'abstained', reason: 'no workflows are in the library', routing: null };
    const config = this.getConfig();
    const settings = resolveClassifierSettings(request.workspace);
    const backend = this.backends[settings.backend];
    if (!backend) return { kind: 'abstained', reason: `the ${settings.backend} backend is not available`, routing: null };
    const options: ModelOption[] = request.workflows.map((w) => ({ id: w.name, description: w.description, harness: 'workflow', model: 'workflow' }));
    const input = classifierInputSchema.parse({
      title: request.title,
      description: request.description,
      labels: [...request.labels],
      attemptNumber: 1,
      options,
    });
    const outcome = await runClassifier(backend, input, {
      timeoutMs: settings.timeoutSeconds * 1000,
      workspace: request.workspace,
      config,
      prompt: buildWorkflowClassifierPrompt(input),
    }, options);
    return outcome.kind === 'chosen'
      ? { kind: 'chosen', name: outcome.option.id, reason: outcome.reason, routing: outcome.routing, prompt: outcome.prompt ?? '' }
      : outcome;
  }
}
