import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dominantModel, foldModels, usageFromModels, type ParsedSession, type ProcessNode, type UsageTurn } from '../usage.js';
import { forEachYielding } from '../../reliability/yield.js';
import type { HarnessAdapter, ModelUsage, SessionTailReader } from './adapter.js';
import { LineCursor, type LineAccumulator } from './incremental-log.js';
import { asRecord, contentText, oneLine, timestamp, withTarget, type TranscriptLogEvent } from './transcript.js';

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

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
  private prev = { input: 0, cached: 0, output: 0 };
  private tools: string[] = [];
  private readonly seenToolCalls = new Set<string>();
  readonly turns: UsageTurn[] = [];
  private started: boolean;

  constructor(private readonly subagent = false) {
    this.started = !subagent;
  }

  fold(line: string): void {
    if (!line.trim()) return;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    if (this.subagent && !this.started) {
      if (entry?.type === 'turn_context' && typeof entry.payload?.model === 'string') {
        this.model = entry.payload.model;
      } else if (entry?.type === 'event_msg' && entry.payload?.type === 'token_count') {
        const total = entry.payload.info?.total_token_usage;
        if (total) this.prev = { input: num(total.input_tokens), cached: num(total.cached_input_tokens), output: num(total.output_tokens) };
      } else if (entry?.type === 'inter_agent_communication_metadata' && entry.payload?.trigger_turn === true) {
        this.started = true;
        this.tools = [];
      }
      return;
    }
    if (entry?.type === 'turn_context' && typeof entry.payload?.model === 'string') {
      this.model = entry.payload.model;
      return;
    }
    if (
      entry?.type === 'response_item' &&
      (entry.payload?.type === 'custom_tool_call' || entry.payload?.type === 'function_call') &&
      typeof entry.payload?.name === 'string'
    ) {
      const id = entry.payload.call_id ?? entry.payload.id;
      if (typeof id !== 'string' || !this.seenToolCalls.has(id)) {
        if (typeof id === 'string') this.seenToolCalls.add(id);
        const namespace = typeof entry.payload.namespace === 'string' ? entry.payload.namespace : null;
        const tool = namespace ? `${namespace}.${entry.payload.name}` : entry.payload.name;
        this.tools.push(tool);
        this.lastTool = tool;
      }
      return;
    }
    const info = entry?.type === 'event_msg' && entry.payload?.type === 'token_count' ? entry.payload.info : null;
    const total = info?.total_token_usage;
    if (!total) return;
    if (typeof info.last_token_usage?.input_tokens === 'number') this.contextTokens = info.last_token_usage.input_tokens;
    const input = num(total.input_tokens);
    const cached = num(total.cached_input_tokens);
    const output = num(total.output_tokens);
    // Codex resets the cumulative counter on session resume: a shrinking
    // counter means the entry is its own delta.
    const reset = input < this.prev.input || cached < this.prev.cached || output < this.prev.output;
    const delta = reset
      ? { input, cached, output }
      : { input: input - this.prev.input, cached: cached - this.prev.cached, output: output - this.prev.output };
    if (this.model) {
      const bucket = (this.models[this.model] ??= {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      bucket.inputTokens += delta.input - delta.cached;
      bucket.cacheReadTokens += delta.cached;
      bucket.outputTokens += delta.output;
      this.turns.push({
        model: this.model,
        usage: {
          inputTokens: delta.input - delta.cached,
          outputTokens: delta.output,
          cacheReadTokens: delta.cached,
          cacheWriteTokens: 0,
        },
        tools: this.tools,
      });
    }
    this.tools = [];
    this.prev.input = input;
    this.prev.cached = cached;
    this.prev.output = output;
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
  const models: Record<string, ModelUsage> = {};
  for (const scan of scans) {
    for (const [model, usage] of Object.entries(scan.models)) {
      const bucket = (models[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
      bucket.inputTokens += usage.inputTokens;
      bucket.outputTokens += usage.outputTokens;
      bucket.cacheReadTokens += usage.cacheReadTokens;
      bucket.cacheWriteTokens += usage.cacheWriteTokens;
    }
  }
  return models;
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

class CodexSessionTailReader implements SessionTailReader {
  private readonly cursors = new Map<string, LineCursor<RolloutAcc>>();
  private cached: ParsedSession | null = null;
  private inflight: Promise<ParsedSession | null> | null = null;

  constructor(private readonly input: { sessionLogDir?: string | undefined; cwd: string; sessionId: string }) {}

  latest(): ParsedSession | null {
    return this.cached;
  }

  sample(): Promise<ParsedSession | null> {
    const run = (this.inflight ?? Promise.resolve(null)).then(
      () => this.doSample(),
      () => this.doSample(),
    );
    this.inflight = run;
    return run;
  }

  private async doSample(): Promise<ParsedSession | null> {
    const rollouts = await findRolloutsYielding(this.input);
    if (rollouts.length === 0) return this.cached;
    for (const rollout of rollouts) {
      let cursor = this.cursors.get(rollout.file);
      if (!cursor) {
        cursor = new LineCursor(rollout.file, () => new RolloutAcc(rollout.parentId !== null));
        this.cursors.set(rollout.file, cursor);
      }
      await cursor.advance();
      rollout.scan = cursor.acc.snapshot();
    }
    this.cached = buildRolloutTree(this.input.sessionId, rollouts);
    return this.cached;
  }
}

function entriesNewestFirst(dir: string): string[] {
  try {
    return readdirSync(dir).sort().reverse();
  } catch {
    return [];
  }
}

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
      name:
        typeof spawn?.agent_path === 'string'
          ? spawn.agent_path
          : typeof payload?.agent_path === 'string'
            ? payload.agent_path
            : typeof spawn?.agent_nickname === 'string'
              ? spawn.agent_nickname
              : typeof payload?.agent_nickname === 'string'
                ? payload.agent_nickname
                : 'subagent',
    };
  } catch {
    return null;
  }
}

function sessionsRoot(input: { sessionLogDir?: string | undefined }): string {
  const codexHome = process.env.CODEX_HOME;
  return input.sessionLogDir ?? (codexHome ? join(codexHome, 'sessions') : join(homedir(), '.codex', 'sessions'));
}

function rolloutFiles(root: string): string[] {
  const files: string[] = [];
  for (const year of entriesNewestFirst(root)) {
    for (const month of entriesNewestFirst(join(root, year))) {
      for (const day of entriesNewestFirst(join(root, year, month))) {
        for (const file of entriesNewestFirst(join(root, year, month, day))) {
          if (file.startsWith('rollout-') && file.endsWith('.jsonl')) files.push(join(root, year, month, day, file));
        }
      }
    }
  }
  return files;
}

async function rolloutFilesYielding(root: string): Promise<string[]> {
  const files: string[] = [];
  await forEachYielding(entriesNewestFirst(root), async (year) => {
    await forEachYielding(entriesNewestFirst(join(root, year)), async (month) => {
      await forEachYielding(entriesNewestFirst(join(root, year, month)), async (day) => {
        const dir = join(root, year, month, day);
        await forEachYielding(entriesNewestFirst(dir), (file) => {
          if (file.startsWith('rollout-') && file.endsWith('.jsonl')) files.push(join(dir, file));
        });
      });
    });
  });
  return files;
}

function findRollouts(input: { sessionLogDir?: string | undefined; cwd: string; sessionId: string }, scan = true): Rollout[] {
  const rootFile = codexAdapter.usage!.sessionLogFile(input);
  if (!rootFile) return [];
  const root = sessionsRoot(input);
  const rollouts = new Map<string, Rollout>([
    [input.sessionId, { id: input.sessionId, parentId: null, name: 'root', file: rootFile, scan: scan ? scanRollout(rootFile) : emptyScan() }],
  ]);
  for (const file of rolloutFiles(root)) {
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
  const files = await rolloutFilesYielding(sessionsRoot(input));
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

function transcriptEvents(entry: unknown, firstId: number): TranscriptLogEvent[] {
  const record = asRecord(entry);
  const payload = asRecord(record?.payload);
  if (!record || !payload) return [];
  const ts = timestamp(record.timestamp);
  const events: TranscriptLogEvent[] = [];
  const push = (update: Record<string, unknown>) => {
    const id = firstId + events.length;
    events.push({ id, seq: id, ts, type: 'session_update', payload: update });
  };
  const message = responseMessage(entry) ?? eventMessage(entry);
  if (message !== null) push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message } });
  if (record.type === 'response_item' && payload.type === 'reasoning' && Array.isArray(payload.summary)) {
    for (const part of payload.summary) {
      const block = asRecord(part);
      const text = block && (block.type === 'summary_text' || block.type === 'text') ? block.text : null;
      // Each Codex reasoning summary is a whole markdown block, not a streaming
      // delta; the transcript coalescer concatenates same-variant chunks with no
      // separator, so a trailing blank line keeps consecutive summaries from
      // fusing into one run (`**A****B**`) when rendered as markdown.
      if (typeof text === 'string' && text) push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: `${text}\n\n` } });
    }
  }
  if (record.type === 'response_item' && (payload.type === 'custom_tool_call' || payload.type === 'function_call')) {
    const name = typeof payload.name === 'string' ? payload.name : 'Tool call';
    const qualified = typeof payload.namespace === 'string' && payload.namespace ? `${payload.namespace}.${name}` : name;
    const callId = typeof payload.call_id === 'string' ? payload.call_id : typeof payload.id === 'string' ? payload.id : qualified;
    const input = payload.input ?? payload.arguments;
    const title = isExecScript(name, input) ? codexExecTitle(input) : codexCallTitle(qualified, input);
    push({ sessionUpdate: 'tool_call', toolCallId: callId, title, status: 'completed' });
  }
  return events;
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

    createTailReader(input) {
      return new CodexSessionTailReader(input);
    },

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
      for (const year of entriesNewestFirst(root)) {
        for (const month of entriesNewestFirst(join(root, year))) {
          for (const day of entriesNewestFirst(join(root, year, month))) {
            for (const file of entriesNewestFirst(join(root, year, month, day))) {
              if (file.startsWith('rollout-') && file.endsWith(suffix)) {
                return join(root, year, month, day, file);
              }
            }
          }
        }
      }
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
