import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../logger.js';
import { dominantModel, foldModels, usageFromModels, type ParsedSession, type ProcessNode, type UsageTurn } from '../usage.js';
import { forEachYielding } from '../../reliability/yield.js';
import { serializedTailReader, type HarnessAdapter, type ModelUsage, type SessionTailReader } from './adapter.js';
import { LineCursor, type LineAccumulator } from './incremental-log.js';
import { mergeModelUsage, num, usageBucket } from './model-usage.js';
import { datedLogFiles } from './session-files.js';
import { asRecord, contentText, oneLine, timestamp, withTarget, type TranscriptLogEvent } from './transcript.js';

/** Codex rollout log filenames: `rollout-<ts>-<sessionId>.jsonl`. */
const isRolloutFile = (name: string): boolean => name.startsWith('rollout-') && name.endsWith('.jsonl');

interface RolloutScan {
  models: Record<string, ModelUsage>;
  contextTokens: number | null;
  lastTool: string | null;
  turns: UsageTurn[];
}

interface Rollout {
  id: string;
  parentId: string | null;
  name: string;
  file: string;
  scan: RolloutScan;
}

interface CumulativeTokens {
  input: number;
  cached: number;
  output: number;
}

function parseRolloutLine(line: string): { entry: any } | null {
  if (!line.trim()) return null;
  try {
    return { entry: JSON.parse(line) };
  } catch (err) {
    logger.debug('codex: skipping a malformed rollout line', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

const turnContextModel = (entry: any): string | null =>
  entry?.type === 'turn_context' && typeof entry.payload?.model === 'string' ? entry.payload.model : null;

const tokenCountInfo = (entry: any): any => (entry?.type === 'event_msg' && entry.payload?.type === 'token_count' ? entry.payload.info : null);

const isToolCall = (entry: any): boolean =>
  entry?.type === 'response_item' &&
  (entry.payload?.type === 'custom_tool_call' || entry.payload?.type === 'function_call') &&
  typeof entry.payload?.name === 'string';

const cumulativeTokens = (total: any): CumulativeTokens => ({
  input: num(total.input_tokens),
  cached: num(total.cached_input_tokens),
  output: num(total.output_tokens),
});

/**
 * One token_count's spend as a ModelUsage. Rollout input includes cached reads,
 * hence the subtraction. Codex resets the cumulative counter on session resume:
 * a shrinking counter means the entry is its own delta.
 */
function tokenDelta(current: CumulativeTokens, prev: CumulativeTokens): ModelUsage {
  const reset = current.input < prev.input || current.cached < prev.cached || current.output < prev.output;
  const base = reset ? { input: 0, cached: 0, output: 0 } : prev;
  const cached = current.cached - base.cached;
  return {
    inputTokens: current.input - base.input - cached,
    outputTokens: current.output - base.output,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

/**
 * Codex rollout format: `turn_context` names the model driving the turn;
 * `event_msg/token_count` carries the *cumulative* session usage, so each
 * entry's delta against the previous one is the current model's spend.
 * Rollout `input_tokens` includes cached reads (ModelUsage.inputTokens is
 * uncached-only) and no cache-write figure exists.
 *
 * ponytail: the rollout's `model_context_window` (window *size*) is not
 * surfaced — ProcessNode has no capacity field (T1/#47) and window size
 * already comes from config (`harnesses.*.models` → `contextWindow`).
 * Read it here if a node ever needs a per-served-model capacity.
 */
class RolloutAcc implements LineAccumulator {
  readonly models: Record<string, ModelUsage> = {};
  private model: string | null = null;
  private contextTokens: number | null = null;
  private lastTool: string | null = null;
  private prev: CumulativeTokens = { input: 0, cached: 0, output: 0 };
  private tools: string[] = [];
  private readonly seenToolCalls = new Set<string>();
  readonly turns: UsageTurn[] = [];
  private started: boolean;

  constructor(private readonly subagent = false) {
    this.started = !subagent;
  }

  fold(line: string): void {
    const parsed = parseRolloutLine(line);
    if (parsed === null) return;
    const { entry } = parsed;
    if (this.subagent && !this.started) this.foldBeforeStart(entry);
    else this.foldEntry(entry);
  }

  /** A forked Subagent rollout replays its parent's history; only the last cumulative count survives as the baseline. */
  private foldBeforeStart(entry: any): void {
    const model = turnContextModel(entry);
    if (model !== null) {
      this.model = model;
      return;
    }
    const total = tokenCountInfo(entry)?.total_token_usage;
    if (total) {
      this.prev = cumulativeTokens(total);
    } else if (entry?.type === 'inter_agent_communication_metadata' && entry.payload?.trigger_turn === true) {
      this.started = true;
      this.tools = [];
    }
  }

  private foldEntry(entry: any): void {
    const model = turnContextModel(entry);
    if (model !== null) {
      this.model = model;
      return;
    }
    if (isToolCall(entry)) {
      this.recordToolCall(entry.payload);
      return;
    }
    const info = tokenCountInfo(entry);
    if (info?.total_token_usage) this.recordTokenCount(info);
  }

  private recordToolCall(payload: any): void {
    const id = payload.call_id ?? payload.id;
    if (typeof id === 'string') {
      if (this.seenToolCalls.has(id)) return;
      this.seenToolCalls.add(id);
    }
    const tool = typeof payload.namespace === 'string' && payload.namespace ? `${payload.namespace}.${payload.name}` : payload.name;
    this.tools.push(tool);
    this.lastTool = tool;
  }

  private recordTokenCount(info: any): void {
    if (typeof info.last_token_usage?.input_tokens === 'number') this.contextTokens = info.last_token_usage.input_tokens;
    const current = cumulativeTokens(info.total_token_usage);
    if (this.model) {
      const usage = tokenDelta(current, this.prev);
      const bucket = usageBucket(this.models, this.model);
      bucket.inputTokens += usage.inputTokens;
      bucket.cacheReadTokens += usage.cacheReadTokens;
      bucket.outputTokens += usage.outputTokens;
      this.turns.push({ model: this.model, usage, tools: this.tools });
    }
    this.tools = [];
    this.prev = current;
  }

  snapshot(): RolloutScan {
    return { models: this.models, contextTokens: this.contextTokens, lastTool: this.lastTool, turns: this.turns };
  }
}

function scanRollout(file: string, subagent = false): RolloutScan {
  const acc = new RolloutAcc(subagent);
  if (!existsSync(file)) return acc.snapshot();
  for (const line of readFileSync(file, 'utf8').split('\n')) acc.fold(line);
  return acc.snapshot();
}

function mergeModels(scans: RolloutScan[]): Record<string, ModelUsage> {
  return mergeModelUsage(scans.map((scan) => scan.models));
}

function buildRolloutTree(rootId: string, rollouts: Rollout[]): ParsedSession {
  const byParent = new Map<string, Rollout[]>();
  const included = new Map<string, Rollout>();
  for (const rollout of rollouts) included.set(rollout.id, rollout);
  for (const rollout of rollouts) {
    if (!rollout.parentId || !included.has(rollout.parentId)) continue;
    const children = byParent.get(rollout.parentId) ?? [];
    children.push(rollout);
    byParent.set(rollout.parentId, children);
  }
  const node = (rollout: Rollout, depth: number): ProcessNode => ({
    id: rollout.id,
    name: depth === 0 ? 'root' : rollout.name,
    model: dominantModel(rollout.scan.models) ?? 'unknown',
    usage: foldModels(rollout.scan.models),
    contextTokens: rollout.scan.contextTokens,
    lastTool: rollout.scan.lastTool,
    status: 'active',
    depth,
    toolUseId: null,
    children: (byParent.get(rollout.id) ?? []).map((child) => node(child, depth + 1)),
  });
  const root = included.get(rootId);
  if (!root) throw new Error(`Missing Codex root rollout ${rootId}`);
  return {
    usage: usageFromModels(mergeModels(rollouts.map((rollout) => rollout.scan))),
    tree: node(root, 0),
    turns: rollouts.flatMap((rollout) => rollout.scan.turns),
  } satisfies ParsedSession;
}

function codexTailReader(input: { sessionLogDir?: string | undefined; cwd: string; sessionId: string }): SessionTailReader {
  const cursors = new Map<string, LineCursor<RolloutAcc>>();
  return serializedTailReader(async (previous) => {
    const rollouts = await findRolloutsYielding(input);
    if (rollouts.length === 0) return previous;
    for (const rollout of rollouts) {
      let cursor = cursors.get(rollout.file);
      if (!cursor) {
        cursor = new LineCursor(rollout.file, () => new RolloutAcc(rollout.parentId !== null));
        cursors.set(rollout.file, cursor);
      }
      await cursor.advance();
      rollout.scan = cursor.acc.snapshot();
    }
    return buildRolloutTree(input.sessionId, rollouts);
  });
}

const firstString = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === 'string');

function rolloutHeader(file: string): Pick<Rollout, 'id' | 'parentId' | 'name'> | null {
  try {
    const [line] = readFileSync(file, 'utf8').split('\n', 1);
    const entry: any = JSON.parse(line ?? '');
    const payload = entry?.type === 'session_meta' ? entry.payload : null;
    const id = payload?.id ?? payload?.session_id;
    if (typeof id !== 'string') return null;
    const spawn = payload?.source?.subagent?.thread_spawn;
    return {
      id,
      parentId: typeof payload?.parent_thread_id === 'string' ? payload.parent_thread_id : null,
      name: firstString(spawn?.agent_path, payload?.agent_path, spawn?.agent_nickname, payload?.agent_nickname) ?? 'subagent',
    };
  } catch (err) {
    logger.debug('codex: rollout header failed to parse', { file, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function sessionsRoot(input: { sessionLogDir?: string | undefined }): string {
  const codexHome = process.env.CODEX_HOME;
  return input.sessionLogDir ?? (codexHome ? join(codexHome, 'sessions') : join(homedir(), '.codex', 'sessions'));
}

function findRollouts(input: { sessionLogDir?: string | undefined; cwd: string; sessionId: string }, scan = true): Rollout[] {
  const rootFile = codexAdapter.usage!.sessionLogFile(input);
  if (!rootFile) return [];
  const root = sessionsRoot(input);
  const rollouts = new Map<string, Rollout>([
    [input.sessionId, { id: input.sessionId, parentId: null, name: 'root', file: rootFile, scan: scan ? scanRollout(rootFile) : emptyScan() }],
  ]);
  for (const file of datedLogFiles(root, isRolloutFile)) {
    if (file === rootFile) continue;
    const header = rolloutHeader(file);
    if (!header || !header.parentId || rollouts.has(header.id)) continue;
    rollouts.set(header.id, { ...header, file, scan: scan ? scanRollout(file, true) : emptyScan() });
  }
  const included = new Set([input.sessionId]);
  for (;;) {
    let added = false;
    for (const rollout of rollouts.values()) {
      if (rollout.parentId && included.has(rollout.parentId) && !included.has(rollout.id)) {
        included.add(rollout.id);
        added = true;
      }
    }
    if (!added) return [...rollouts.values()].filter((rollout) => included.has(rollout.id));
  }
}

async function findRolloutsYielding(input: { sessionLogDir?: string | undefined; cwd: string; sessionId: string }): Promise<Rollout[]> {
  const files: string[] = [];
  await forEachYielding(datedLogFiles(sessionsRoot(input), isRolloutFile), (file) => {
    files.push(file);
  });
  const rootFile = files.find((file) => file.endsWith(`-${input.sessionId}.jsonl`));
  if (!rootFile) return [];
  const rollouts = new Map<string, Rollout>([[input.sessionId, { id: input.sessionId, parentId: null, name: 'root', file: rootFile, scan: emptyScan() }]]);
  await forEachYielding(files, (file) => {
    if (file === rootFile) return;
    const header = rolloutHeader(file);
    if (!header || !header.parentId || rollouts.has(header.id)) return;
    rollouts.set(header.id, { ...header, file, scan: emptyScan() });
  });
  const included = new Set([input.sessionId]);
  for (;;) {
    let added = false;
    await forEachYielding(rollouts.values(), (rollout) => {
      if (rollout.parentId && included.has(rollout.parentId) && !included.has(rollout.id)) {
        included.add(rollout.id);
        added = true;
      }
    });
    if (!added) return [...rollouts.values()].filter((rollout) => included.has(rollout.id));
  }
}

function emptyScan(): RolloutScan {
  return { models: {}, contextTokens: null, lastTool: null, turns: [] };
}

/** Codex's ACP modelId grammar is `<model>[<effort>]`; effort is optional. */
function splitModelId(model: string): { base: string; effort: string | null } {
  const match = /^(.*)\[([^\]]+)\]$/.exec(model);
  return match ? { base: match[1]!, effort: match[2]! } : { base: model, effort: null };
}

const eventMessage = (entry: unknown): string | null => {
  const record = asRecord(entry);
  const payload = asRecord(record?.payload);
  return record?.type === 'event_msg' && payload?.type === 'agent_message' ? contentText(payload.message) : null;
};

const responseMessage = (entry: unknown): string | null => {
  const record = asRecord(entry);
  const payload = asRecord(record?.payload);
  return record?.type === 'response_item' && payload?.type === 'message' && payload.role === 'assistant' ? contentText(payload.content) : null;
};

/**
 * Codex's `exec` tool can carry a freeform JS snippet that drives the sandbox
 * instead of a plain command: `tools.exec_command({cmd})` runs shell,
 * `tools.apply_patch(patch)` edits files, `tools.mcp__<server>__<tool>({...})`
 * calls an MCP tool. Unwrap it to the underlying action so the transcript shows
 * the command, not the harness plumbing wrapped around it. A shell call reduces
 * to the same `exec <cmd>` title the structured `{"command":[…]}` form yields.
 */
function isExecScript(name: string, input: unknown): input is string {
  return name === 'exec' && typeof input === 'string' && /tools\.\w+\s*\(|^\s*const\s|\*\*\* (?:Add|Update|Delete) File:/.test(input);
}

function codexExecTitle(src: string): string {
  const files = [...src.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^"\\\n]+)/g)].map((m) => m[1]!.trim());
  if (files.length) return oneLine(`apply_patch ${files[0]}${files.length > 1 ? ` (+${files.length - 1})` : ''}`);
  const cmds = [...src.matchAll(/"cmd"\s*:\s*("(?:\\.|[^"\\])*")/g)]
    .map((m) => {
      try {
        return JSON.parse(m[1]!) as string;
      } catch {
        return null;
      }
    })
    .filter((cmd): cmd is string => cmd !== null);
  if (cmds.length) return oneLine(`exec ${cmds[0]}${cmds.length > 1 ? ` (+${cmds.length - 1})` : ''}`);
  const mcp = /tools\.mcp__(.+?)__([A-Za-z0-9_]+)\s*\(\s*\{([^]*?)\}/.exec(src);
  if (mcp) {
    const action = /\baction\s*:\s*["']([^"']+)["']/.exec(mcp[3]!)?.[1];
    return oneLine(`${mcp[1]}.${mcp[2]}${action ? ` ${action}` : ''}`);
  }
  const other = /tools\.([A-Za-z0-9_]+)\s*\(/.exec(src);
  if (other) return other[1]!;
  return oneLine(`exec ${src}`);
}

/**
 * Codex's `collaboration` function calls carry an encrypted `message` payload
 * that {@link withTarget} would otherwise surface as an opaque blob; prefer the
 * readable spawn/followup target so the transcript names the delegated agent.
 */
function codexCallTitle(qualified: string, args: unknown): string {
  let record = asRecord(args);
  if (typeof args === 'string') {
    try {
      record = asRecord(JSON.parse(args));
    } catch {
      record = null;
    }
  }
  const label = record?.task_name ?? record?.target;
  return typeof label === 'string' && label ? `${qualified} ${oneLine(label)}` : withTarget(qualified, args);
}

type SessionUpdate = Record<string, unknown>;

const textChunk = (sessionUpdate: string, text: string): SessionUpdate => ({ sessionUpdate, content: { type: 'text', text } });

function messageUpdates(entry: unknown): SessionUpdate[] {
  const message = responseMessage(entry) ?? eventMessage(entry);
  return message === null ? [] : [textChunk('agent_message_chunk', message)];
}

const asStandaloneMarkdownBlock = (text: string): string => `${text}\n\n`;

function reasoningUpdates(record: Record<string, unknown>, payload: Record<string, unknown>): SessionUpdate[] {
  if (record.type !== 'response_item' || payload.type !== 'reasoning' || !Array.isArray(payload.summary)) return [];
  return payload.summary
    .map((part) => {
      const block = asRecord(part);
      return block && (block.type === 'summary_text' || block.type === 'text') ? block.text : null;
    })
    .filter((text): text is string => typeof text === 'string' && text !== '')
    .map((text) => textChunk('agent_thought_chunk', asStandaloneMarkdownBlock(text)));
}

function toolCallUpdates(record: Record<string, unknown>, payload: Record<string, unknown>): SessionUpdate[] {
  if (record.type !== 'response_item' || (payload.type !== 'custom_tool_call' && payload.type !== 'function_call')) return [];
  const name = typeof payload.name === 'string' ? payload.name : 'Tool call';
  const qualified = typeof payload.namespace === 'string' && payload.namespace ? `${payload.namespace}.${name}` : name;
  const callId = firstString(payload.call_id, payload.id) ?? qualified;
  const input = payload.input ?? payload.arguments;
  const title = isExecScript(name, input) ? codexExecTitle(input) : codexCallTitle(qualified, input);
  return [{ sessionUpdate: 'tool_call', toolCallId: callId, title, status: 'completed' }];
}

function transcriptEvents(entry: unknown, firstId: number): TranscriptLogEvent[] {
  const record = asRecord(entry);
  const payload = asRecord(record?.payload);
  if (!record || !payload) return [];
  const ts = timestamp(record.timestamp);
  return [...messageUpdates(entry), ...reasoningUpdates(record, payload), ...toolCallUpdates(record, payload)].map((update, index) => ({
    id: firstId + index,
    seq: firstId + index,
    ts,
    type: 'session_update',
    payload: update,
  }));
}

export const codexAdapter: HarnessAdapter = {
  commandPrefix: '$',
  transcript: {
    events: transcriptEvents,
    isDuplicateMessage: (entry, previousEntry) => {
      const message = responseMessage(entry);
      return message !== null && message === eventMessage(previousEntry);
    },
  },
  // CODEX_CONFIG is a JSON object merged into the Codex session config.
  spawnEnv: ({ model }) => {
    const { base, effort } = splitModelId(model);
    return {
      // Over ACP neither `approval_policy` nor Codex's command-line YOLO flags
      // grant unattended access; only the `agent-full-access` session mode
      // (session/set_mode, which the Runner sets after the handshake) does.
      // `danger-full-access` is that mode's sandbox-policy name, not the ACP id.
      CODEX_CONFIG: JSON.stringify({ approval_policy: 'on-request', model: base, ...(effort ? { model_reasoning_effort: effort } : {}) }),
    };
  },

  mcpServers: ({ url, token }) => [
    {
      name: 'harmonic',
      type: 'http',
      url,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    },
  ],
  unattendedPermissionMode: (available) => (available.includes('agent-full-access') ? 'agent-full-access' : undefined),
  requiresUnattendedPermissionMode: false,

  usage: {
    resolveTranscriptPath({ sessionLogDir, sessionId }) {
      return Promise.resolve(codexAdapter.usage!.sessionLogFile({ sessionLogDir, cwd: '', sessionId }));
    },
    parse(input) {
      if (!input.sessionId) return null;
      const rollouts = findRollouts({ ...input, sessionId: input.sessionId });
      return rollouts.length > 0 ? buildRolloutTree(input.sessionId, rollouts) : null;
    },

    createTailReader: codexTailReader,

    /**
     * Codex attributes usage per model on the prompt result itself,
     * `_meta.quota.model_usage`; `inputTokens` there is uncached input,
     * `cachedInputTokens` the cache reads, and no cache-write figure exists.
     */
    modelsFromPromptResult(result) {
      const entries = (result as any)?._meta?.quota?.model_usage;
      if (!Array.isArray(entries)) return {};
      const models: Record<string, ModelUsage> = {};
      for (const entry of entries) {
        if (typeof entry?.model !== 'string' || !entry?.token_count) continue;
        const bucket = (models[entry.model] ??= {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
        bucket.inputTokens += num(entry.token_count.inputTokens);
        bucket.outputTokens += num(entry.token_count.outputTokens);
        bucket.cacheReadTokens += num(entry.token_count.cachedInputTokens);
      }
      return models;
    },

    /**
     * Codex rollout logs live at
     * `<root>/<YYYY>/<MM>/<DD>/rollout-<ts>-<sessionId>.jsonl`; the ACP
     * sessionId is embedded verbatim in the filename and the timestamp part is
     * unknowable, so search the dated tree, newest day first.
     */
    sessionLogFile({ sessionLogDir, sessionId }) {
      if (!sessionId) return null;
      const root = sessionsRoot({ sessionLogDir });
      const suffix = `-${sessionId}.jsonl`;
      for (const file of datedLogFiles(root, (name) => name.startsWith('rollout-') && name.endsWith(suffix))) return file;
      return null;
    },

    modelsFromSessionLog(file) {
      return scanRollout(file).models;
    },

    toolName() {
      return null;
    },
  },
};
