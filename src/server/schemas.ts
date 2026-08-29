import { z } from 'zod';
import {
  ATTEMPT_STATES,
  STEP_STATES,
  STEP_TYPES,
  RUN_STATES,
  CONVERSATION_STATES,
} from '../db/schema.js';
import { listResponse } from './pagination.js';

/**
 * Shared response schemas for zod-declared routes (ADR-0005). Every route's
 * `schema.response` should reuse these instead of redefining the error
 * envelope shape, so the generated spec documents one consistent contract.
 *
 * Fields carry `.meta({ example })` wherever a plausible value helps more than
 * a type name does: the API page renders the spec's examples verbatim and only
 * synthesizes placeholders where none is declared, so an example here is the
 * difference between a reader seeing `"claude"` and seeing `"string"`.
 * Examples are illustrative, not captured traffic.
 */

/** The `{ error: { code, message } }` envelope every error response uses — see app.ts's error handler. */
export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().meta({ example: 'not_found' }),
      message: z.string().meta({ example: 'no task with id 4821' }),
    }),
  })
  .meta({ id: 'ErrorResponse' });

/**
 * The error envelope with a description for one specific failure.
 *
 * `.describe()` on a registered schema keeps the `$ref` and adds the
 * description beside it, so each status documents what *it* means without
 * inlining a copy of the envelope or renaming the shared definition. Fastify's
 * swagger integration reads that description as the response's own — this is
 * what replaces "Default Response".
 */
export const errorResponse = (description: string) => errorResponseSchema.describe(description);

/** The trivial `{ ok: true }` body returned by actions with nothing else to report. */
export const okResponseSchema = z
  .object({ ok: z.literal(true) })
  .meta({ id: 'OkResponse', example: { ok: true } });

/** A numeric `:id` path param, coerced from the route string — shared by tasks/runs/channels. */
export const idParamsSchema = z.object({ id: z.coerce.number().int().meta({ example: 4821 }) });

/** One persisted step in an Attempt's ordered ticket timeline (ADR-0041). */
export const stepSchema = z
  .object({
    id: z.number().meta({ example: 73 }),
    attemptId: z.number().meta({ example: 19 }),
    type: z.enum(STEP_TYPES).meta({ example: 'verification' }),
    position: z.number().int().positive().meta({ example: 2 }),
    state: z.enum(STEP_STATES).meta({ example: 'passed' }),
    command: z.string().nullable().meta({ example: 'npm test' }),
    verdict: z.string().nullable().meta({ example: 'pass' }),
    logLocator: z.string().nullable().meta({ example: 'verification_attempt:31' }),
    startedAt: z.number().nullable().meta({ example: 1784032140000 }),
    endedAt: z.number().nullable().meta({ example: 1784032200000 }),
  })
  .meta({ id: 'Step' });

/** One configured verifier category's reconciled read-time state (issue #327). */
export const verifierStatusSchema = z
  .object({
    mechanism: z.enum(['command', 'critic']).meta({ example: 'critic' }),
    state: z.enum(['passed', 'failed', 'inconclusive', 'skipped', 'disabled', 'unrunnable', 'planned']).meta({ example: 'passed' }),
    reason: z.string().nullable().meta({ example: null }),
    commands: z.array(z.string()).optional().meta({ example: ['npm test'] }),
  })
  .meta({ id: 'VerifierStatus' });

/** One implementation-to-verification iteration and its ordered work rows. */
export const attemptSchema = z
  .object({
    id: z.number().meta({ example: 19 }),
    taskId: z.number().meta({ example: 4821 }),
    number: z.number().int().positive().meta({ example: 1 }),
    state: z.enum(ATTEMPT_STATES).meta({ example: 'passed' }),
    startedAt: z.number().meta({ example: 1784032020000 }),
    endedAt: z.number().nullable().meta({ example: 1784032200000 }),
    /** The failure feedback this attempt closed with — what the next attempt was told to fix. */
    feedback: z.string().nullable().meta({ example: 'The rate limiter must be shared across workers.' }),
    /** The branch tip this attempt's verification proved (its `verified-head` fact); null until verification ran. */
    verifiedSha: z.string().nullable().meta({ example: '0f758cd2200565e7605902a86c2827c65ad25ce0' }),
    /** Why this attempt handed the ticket to a human (its `escalate` settle fact); null unless it escalated. */
    escalationReason: z.string().nullable().meta({ example: 'escalated to human: verification failed after 3 attempt(s)' }),
    continuation: z.object({
      path: z.enum(['continued-session', 'new-session-condensed']),
      reason: z.enum(['continued-within-limits', 'context-tokens', 'session-cold', 'missing-context-tokens', 'missing-warm-window']),
      contextTokens: z.number().nullable(),
      contextReuseTokenLimit: z.number(),
      lastActiveAt: z.number(),
      lastActiveAgeMs: z.number(),
      warmWindowMs: z.number().nullable(),
    }).nullable(),
    /** One row per verifier category, including skipped and disabled states. */
    verifierStatuses: z.array(verifierStatusSchema),
    steps: z.array(stepSchema),
  })
  .meta({ id: 'Attempt' });

/** The ticket timeline shape shared by REST and the WebSocket firehose. The REST
 * `/tasks/:id/attempts` view carries the shared `total` envelope (ADR-0045); the
 * firehose broadcast (ws.ts) sends the whole `attempts` list and simply omits the
 * REST-only `total`, so both surfaces stay in step when no page is requested. */
export const attemptTimelineResponseSchema = listResponse('attempts', attemptSchema)
  .extend({
    /** The attempt number the `maxAttempts` budget counts from (ADR-0041): the last
     * escalated Attempt, or 0. `latest.number - budgetBase` is the position within
     * the current budget — history numbering never resets, the budget does. */
    budgetBase: z.number().int().nonnegative().meta({ example: 0 }),
  })
  .meta({ id: 'AttemptTimelineResponse' })
  .describe('Ordered attempt timeline, with each attempt task and its outcome, plus the attempt number the budget counts from.');

/** Per-model token counters (execution/usage.ts `ModelUsage`) — the four counters Cost prices. */
export const modelUsageSchema = z
  .object({
    inputTokens: z.number().meta({ example: 18240 }),
    outputTokens: z.number().meta({ example: 3610 }),
    cacheReadTokens: z.number().meta({ example: 26400 }),
    cacheWriteTokens: z.number().meta({ example: 1200 }),
    /** Harness-native spend units (e.g. Copilot AI Units); absent when the harness has none. */
    aiUnits: z.number().optional().meta({ example: 12 }),
  })
  .meta({ id: 'ModelUsage' });

/** Output-token attribution for a tool or the no-tool reasoning bucket. */
export const toolTokenUsageSchema = z.object({
  outputTokens: z.number().meta({ example: 3610 }),
  /** API-equivalent output cost; absent when that turn's model was unpriced. */
  cost: z.number().optional().meta({ example: 0.05415 }),
});

/** Usage aggregate for a run or a rolled-up set of runs (execution/usage.ts `RunUsage`). */
export const runUsageSchema = z
  .object({
    /** Per-model breakdown (session-log fallback; ACP only reports aggregates). */
    models: z.record(z.string(), modelUsageSchema).meta({
      example: {
        'sonnet-5': { inputTokens: 18240, outputTokens: 3610, cacheReadTokens: 26400, cacheWriteTokens: 1200 },
      },
    }),
    /** Per-agent-type breakdown (root session + each Subagent type); absent when the harness parsed no Process Tree. */
    agents: z
      .record(z.string(), modelUsageSchema)
      .optional()
      .meta({
        example: {
          root: { inputTokens: 40120, outputTokens: 5200, cacheReadTokens: 60300, cacheWriteTokens: 2400 },
        },
      }),
    /** Output tokens + API-equivalent cost attributed from parsed turns. Absent
     * when this harness did not expose enough turn-level evidence. */
    toolTokens: z.record(z.string(), toolTokenUsageSchema).optional(),
    /** Parsed output from turns that called no tool. */
    reasoning: toolTokenUsageSchema.optional(),
    /** Aggregate token counts; null when no source reported tokens. */
    totals: modelUsageSchema.extend({ totalTokens: z.number().meta({ example: 49450 }).nullable() }).nullable(),
    /** Tool-call tallies from the run's events. */
    toolCalls: z.record(z.string(), z.number()).meta({ example: { read: 14, edit: 6, bash: 3 } }),
    source: z.enum(['acp', 'session-log', 'combined']).nullable().meta({ example: 'acp' }),
  })
  .meta({ id: 'RunUsage' });

/** The dollar value of Usage, derived on read from the live price table (execution/pricing.ts `Cost`). */
export const costSchema = z
  .object({
    /** Sum over priced models; null when nothing could be priced. */
    totalUsd: z.number().nullable().meta({ example: 0.52 }),
    /** $ per model; null for models without a price entry. */
    byModel: z.record(z.string(), z.number().nullable()).meta({ example: { 'sonnet-5': 0.52 } }),
    /** True when any tokens in the aggregate could not be priced. */
    incomplete: z.boolean().meta({ example: false }),
  })
  .meta({ id: 'Cost' });

/**
 * One node of a Process Tree (execution/usage.ts `ProcessNode`): the root
 * Run/Conversation session or a recursive Subagent. Recursive via a Zod-4
 * lazy getter on `children`; `usage` is the node's *own* tokens (roll-ups
 * sum the subtree).
 */
export const processNodeSchema = z
  .object({
    /** Harness session/subagent id (root: the run's sessionId). */
    id: z.string().meta({ example: 'sess_01H8X…' }),
    /** Subagent agentType, or a label for the root process. */
    name: z.string().meta({ example: 'root' }),
    /** Model serving this node's calls (its price bucket in a roll-up). */
    model: z.string().meta({ example: 'sonnet-5' }),
    /** This node's own token usage, excluding its children. */
    usage: modelUsageSchema,
    /** Latest context-window fill for this node; null when unknown. */
    contextTokens: z.number().nullable().meta({ example: 48210 }),
    status: z.enum(['active', 'inactive', 'hidden']).meta({ example: 'active' }),
    /** 0 for the root; +1 per Subagent nesting level. */
    depth: z.number().meta({ example: 0 }),
    /** A Subagent's spawning tool-use id — the drill-in frame key; null for the root. */
    toolUseId: z.string().nullable().meta({ example: 'toolu_01H8X…' }),
    get children() {
      return z.array(processNodeSchema);
    },
  })
  .meta({ id: 'ProcessNode' });

/**
 * One live process in the instance-wide Activity snapshot (issue #51): an
 * in-flight Run or a warm Conversation, from the in-memory registries joined
 * with each session's latest Usage. A Run carries the full live snapshot
 * (rolled-up Usage, context fill, current-activity line, Process Tree,
 * derived Cost); a Conversation has no live tailer, so its `tree`/`activity`
 * are null and its Usage/context come from the Conversation row. `startedAt`
 * is the source of truth for elapsed — the client ticks it live rather than
 * reading a value stale the moment it was sent.
 */
export const activityProcessSchema = z
  .object({
    type: z.enum(['run', 'chat']).meta({ example: 'run' }),
    /** The Run's id (type `run`), else null. */
    runId: z.number().nullable().meta({ example: 4821 }),
    /** The Conversation's id (type `chat`), else null. */
    conversationId: z.number().nullable().meta({ example: null }),
    /** The owning Task's id (type `run`), else null. */
    taskId: z.number().nullable().meta({ example: 512 }),
    /** Display title: a Run's Task prompt first line, a Conversation's title. */
    title: z.string().meta({ example: 'Add the Activity rail view' }),
    workspaceId: z.number().meta({ example: 1 }),
    /** The owning Workspace's name — the view spans Workspaces. */
    workspaceName: z.string().meta({ example: 'harmonic' }),
    /** One of config.ts's HARNESS_IDS ('claude' | 'codex' | 'copilot'); stored as plain text. */
    harness: z.string().meta({ example: 'claude' }),
    model: z.string().meta({ example: 'sonnet-5' }),
    /** A running Run's RunState, or a warm Conversation's ConversationState. */
    state: z.enum([...RUN_STATES, ...CONVERSATION_STATES]).meta({ example: 'running' }),
    /** Isolation Mode ('direct' | 'worktree', config.ts ISOLATION_MODES); always 'direct' for a Conversation (ADR-0006). Stored as plain text. */
    isolation: z.string().meta({ example: 'worktree' }),
    /** Epoch ms the process started; the client derives elapsed from it. */
    startedAt: z.number().meta({ example: 1784032260000 }),
    /** The mirrored issue's tracker ref (a Run's Task); null on native Tasks and Conversations. */
    trackerRef: z.number().nullable().meta({ example: 51 }),
    /** The mirrored issue's tracker URL — the Activity row's ticket deep-link (issue #55); null on native Tasks, Conversations, or before a poll. */
    trackerUrl: z.string().nullable().meta({ example: 'https://github.com/mintopia/harmonic/issues/55' }),
    /** True when the Task is escalated (ADR-0041) — the "Needs you" signal; always false for a Conversation. */
    escalated: z.boolean().meta({ example: false }),
    /** Rolled-up Usage; null before any tokens are reported. */
    usage: runUsageSchema.nullable(),
    /** Root session's latest context-window fill; null when unknown. */
    contextTokens: z.number().nullable().meta({ example: 48210 }),
    /** The model's configured context window; null when unconfigured (percentage suppressed). */
    contextWindow: z.number().nullable().meta({ example: 200000 }),
    /** One-line "what the agent is doing now" (Runs only); null otherwise. */
    activity: z.string().nullable().meta({ example: 'Editing src/foo.ts' }),
    /** The process's Process Tree (Runs only); null for a Conversation. */
    tree: processNodeSchema.nullable(),
    /** Cost derived from Usage on read; null when nothing could be priced. */
    cost: costSchema.nullable(),
  })
  .meta({ id: 'ActivityProcess' });

/** One recurring, centrally registered Scheduled Job (ADR-0038). */
export const scheduledJobSchema = z
  .object({
    jobKey: z.string().meta({ example: 'session-retirement:global' }),
    name: z.string().meta({ example: 'Session retirement drain' }),
    workspaceId: z.number().nullable().meta({ example: null }),
    intervalMs: z.number().int().positive().meta({ example: 300000 }),
    status: z.enum(['active', 'disabled']).meta({ example: 'active' }),
    lastRunAt: z.number().nullable().meta({ example: 1784032260000 }),
    lastStatus: z.enum(['ok', 'error']).nullable().meta({ example: 'ok' }),
    lastDurationMs: z.number().int().nonnegative().nullable().meta({ example: 124 }),
    lastError: z.string().nullable().meta({ example: null }),
    /** The OTel span id of the Job's most recent firing this process (ADR-0010); null before its first run since boot. */
    lastOperationSpanId: z.string().nullable().meta({ example: 'a1b2c3d4e5f60718' }),
    nextRunAt: z.number().nullable().meta({ example: 1784032560000 }),
  })
  .meta({ id: 'ScheduledJob' });

/** A managed worktree the boot/periodic reconciler will not delete until an
 * operator disposes of it by hand (ADR-0010, issue #386). */
export const flaggedWorktreeSchema = z
  .object({
    path: z.string().meta({ example: '/data/worktrees/task-42' }),
    repoDir: z.string().meta({ example: '/home/operator/repo' }),
    workspaceId: z.number().meta({ example: 1 }),
    taskId: z.number().nullable().meta({ example: 42 }),
    branch: z.string().nullable().meta({ example: 'harmonic/task-42' }),
    reason: z.enum(['dirty', 'unreadable', 'unrecognized']).meta({ example: 'dirty' }),
  })
  .meta({ id: 'FlaggedWorktree' });

/** One live or recently-completed Operation, recursive through `children`. */
export const operationSchema = z
  .object({
    type: z.string().meta({ example: 'tracker.poll' }),
    name: z.string().meta({ example: 'harmonic.tracker.poll' }),
    traceId: z.string().meta({ example: '0af7651916cd43dd8448eb211c80319c' }),
    spanId: z.string().meta({ example: 'b7ad6b7169203331' }),
    parentSpanId: z.string().nullable().meta({ example: null }),
    attributes: z.record(z.string(), z.unknown()).meta({ example: { 'tracker.name': 'github' } }),
    startedAt: z.number().meta({ example: 1784032260000 }),
    endedAt: z.number().nullable().meta({ example: null }),
    status: z.object({ code: z.number(), message: z.string().nullable() }),
    get children() {
      return z.array(operationSchema);
    },
  })
  .meta({ id: 'Operation' });
