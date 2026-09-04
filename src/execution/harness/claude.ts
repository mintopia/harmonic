import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { access, readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { dominantModel, foldModels, usageFromModels, type ParsedSession, type ProcessNode, type UsageTurn } from '../usage.js';
import type { HarnessAdapter, ModelUsage, SessionTailReader } from './adapter.js';
import { LineCursor, type LineAccumulator } from './incremental-log.js';
import { asRecord, timestamp, withTarget, type TranscriptLogEvent } from './transcript.js';

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

function mergeInto(dest: Record<string, ModelUsage>, src: Record<string, ModelUsage>): void {
  for (const [model, u] of Object.entries(src)) {
    const bucket = (dest[model] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    bucket.inputTokens += u.inputTokens;
    bucket.outputTokens += u.outputTokens;
    bucket.cacheReadTokens += u.cacheReadTokens;
    bucket.cacheWriteTokens += u.cacheWriteTokens;
  }
}

interface Transcript {
  /** Per-model usage; chunked assistant messages repeat the id, so dedupe on it. */
  models: Record<string, ModelUsage>;
  contextTokens: number | null;
  lastTool: string | null;
  /** tool_use ids that received a tool_result here — a spawned Subagent that has finished. */
  completed: Set<string>;
  turns: UsageTurn[];
}

class TranscriptAcc implements LineAccumulator {
  readonly models: Record<string, ModelUsage> = {};
  private readonly seen = new Set<string>();
  readonly completed = new Set<string>();
  readonly turns: UsageTurn[] = [];
  contextTokens: number | null = null;
  lastTool: string | null = null;

  fold(line: string): void {
    if (!line.trim()) return;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      return;
    }
    const message = entry?.message;
    if (Array.isArray(message?.content)) {
      for (const block of message.content) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') this.completed.add(block.tool_use_id);
      }
    }
    if (entry?.type !== 'assistant' || !message?.model || !message?.usage) return;
    const key = typeof message.id === 'string' ? message.id : line;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const u = message.usage;
    const bucket = (this.models[message.model] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    bucket.inputTokens += num(u.input_tokens);
    bucket.outputTokens += num(u.output_tokens);
    bucket.cacheReadTokens += num(u.cache_read_input_tokens);
    bucket.cacheWriteTokens += num(u.cache_creation_input_tokens);
    this.contextTokens = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    const tools = Array.isArray(message.content)
      ? message.content
          .filter((block: unknown) => (block as { type?: unknown })?.type === 'tool_use')
          .map((block: unknown) => (block as { name?: unknown }).name)
          .filter((name: unknown): name is string => typeof name === 'string')
      : [];
    this.lastTool = tools.at(-1) ?? this.lastTool;
    this.turns.push({
      model: message.model,
      usage: {
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheReadTokens: num(u.cache_read_input_tokens),
        cacheWriteTokens: num(u.cache_creation_input_tokens),
      },
      tools,
    });
  }

  snapshot(): Transcript {
    return { models: this.models, contextTokens: this.contextTokens, lastTool: this.lastTool, completed: this.completed, turns: this.turns };
  }
}

function scanTranscript(file: string): Transcript {
  const acc = new TranscriptAcc();
  if (!existsSync(file)) return acc.snapshot();
  for (const line of readFileSync(file, 'utf8').split('\n')) acc.fold(line);
  return acc.snapshot();
}

interface SubagentMeta {
  agentType?: string;
  name?: string;
  model?: string;
  toolUseId?: string;
  parentAgentId?: string;
  spawnDepth?: number;
}

interface Subagent {
  /** The `<id>` in `agent-<id>.jsonl` — equals the transcript's `agentId`, the join key for nesting. */
  id: string;
  meta: SubagentMeta;
  scan: Transcript;
}

/**
 * Claude Code writes a Subagent's `agent-<id>.jsonl` and `.meta.json` sidecar
 * non-atomically; either can appear before the other mid-run, so a stem with
 * only one of the pair is still returned.
 */
function readSubagents(subDir: string): Subagent[] {
  if (!existsSync(subDir)) return [];
  const found = new Map<string, { dir: string; jsonl?: string; meta?: string }>();
  for (const rel of readdirSync(subDir, { recursive: true }) as string[]) {
    const m = /^agent-(.+)\.(jsonl|meta\.json)$/.exec(basename(rel));
    if (!m) continue;
    const abs = join(subDir, rel);
    const entry = found.get(m[1]!) ?? { dir: dirname(abs) };
    if (m[2] === 'jsonl') entry.jsonl = abs;
    else entry.meta = abs;
    found.set(m[1]!, entry);
  }
  const subs: Subagent[] = [];
  for (const [id, { jsonl, meta }] of found) {
    let parsed: SubagentMeta = {};
    if (meta) {
      try {
        parsed = JSON.parse(readFileSync(meta, 'utf8'));
      } catch {
      }
    }
    subs.push({ id, meta: parsed, scan: jsonl ? scanTranscript(jsonl) : { models: {}, contextTokens: null, lastTool: null, completed: new Set(), turns: [] } });
  }
  return subs;
}

function subagentsDir(rootFile: string): string {
  return join(dirname(rootFile), basename(rootFile, '.jsonl'), 'subagents');
}

function buildParsed(rootId: string, rootScan: Transcript, subs: Subagent[]): ParsedSession {
  const completed = new Set<string>(rootScan.completed);
  for (const s of subs) for (const id of s.scan.completed) completed.add(id);

  const root: ProcessNode = {
    id: rootId,
    name: 'root',
    model: dominantModel(rootScan.models) ?? 'unknown',
    usage: foldModels(rootScan.models),
    contextTokens: rootScan.contextTokens,
    lastTool: rootScan.lastTool,
    status: 'active',
    depth: 0,
    toolUseId: null,
    children: [],
  };

  const byId = new Map<string, ProcessNode>();
  const pending: { node: ProcessNode; parentAgentId: string | undefined }[] = [];
  for (const s of subs) {
    const node: ProcessNode = {
      id: s.id,
      name: s.meta.agentType ?? s.meta.name ?? 'subagent',
      model: dominantModel(s.scan.models) ?? s.meta.model ?? 'unknown',
      usage: foldModels(s.scan.models),
      contextTokens: s.scan.contextTokens,
      lastTool: s.scan.lastTool,
      status: s.meta.toolUseId && completed.has(s.meta.toolUseId) ? 'inactive' : 'active',
      depth: typeof s.meta.spawnDepth === 'number' ? s.meta.spawnDepth : 1,
      toolUseId: s.meta.toolUseId ?? null,
      children: [],
    };
    byId.set(s.id, node);
    pending.push({ node, parentAgentId: s.meta.parentAgentId });
  }
  for (const { node, parentAgentId } of pending) {
    ((parentAgentId && byId.get(parentAgentId)) || root).children.push(node);
  }

  const rolled: Record<string, ModelUsage> = {};
  mergeInto(rolled, rootScan.models);
  for (const s of subs) mergeInto(rolled, s.scan.models);
  return { usage: usageFromModels(rolled), tree: root, turns: [...rootScan.turns, ...subs.flatMap((sub) => sub.scan.turns)] } satisfies ParsedSession;
}

const emptyTranscript = (): Transcript => ({ models: {}, contextTokens: null, lastTool: null, completed: new Set<string>(), turns: [] });

function claudeProjectsDir(sessionLogDir: string | undefined): string {
  if (!sessionLogDir) return join(homedir(), '.claude', 'projects');
  return resolve(sessionLogDir === '~' ? homedir() : sessionLogDir.replace(/^~\//, `${homedir()}/`));
}

/** Find Claude's actual transcript, avoiding its unstable cwd-slug convention. */
async function resolveTranscriptPath(sessionLogDir: string | undefined, sessionId: string): Promise<string | null> {
  const root = claudeProjectsDir(sessionLogDir);
  try {
    const projects = await readdir(root, { withFileTypes: true });
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const candidate = join(root, project.name, `${sessionId}.jsonl`);
      try {
        await access(candidate);
        return await realpath(candidate);
      } catch {
      }
    }
  } catch {
  }
  return null;
}

interface SubEntry {
  id: string;
  jsonlPath?: string;
  metaPath?: string;
  cursor?: LineCursor<TranscriptAcc>;
  meta: SubagentMeta;
  metaResolved: boolean;
}

class ClaudeSessionTailReader implements SessionTailReader {
  private readonly rootFile: string | null;
  private readonly subDir: string | null;
  private rootCursor: LineCursor<TranscriptAcc> | null = null;
  private readonly subs = new Map<string, SubEntry>();
  private cached: ParsedSession | null = null;
  private inflight: Promise<ParsedSession | null> | null = null;

  constructor(private readonly input: { sessionLogDir?: string | undefined; cwd: string; sessionId: string }) {
    this.rootFile = claudeAdapter.usage!.sessionLogFile(input);
    this.subDir = this.rootFile ? subagentsDir(this.rootFile) : null;
  }

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
    if (!this.rootFile) return null;
    if (!this.rootCursor) {
      if (!existsSync(this.rootFile)) return this.cached;
      this.rootCursor = new LineCursor(this.rootFile, () => new TranscriptAcc());
    }
    await this.discoverSubs();
    await Promise.all([this.rootCursor.advance(), ...[...this.subs.values()].map((s) => this.advanceSub(s))]);
    const subs: Subagent[] = [...this.subs.values()].map((s) => ({
      id: s.id,
      meta: s.meta,
      scan: s.cursor ? s.cursor.acc.snapshot() : emptyTranscript(),
    }));
    this.cached = buildParsed(this.input.sessionId, this.rootCursor.acc.snapshot(), subs);
    return this.cached;
  }

  private async discoverSubs(): Promise<void> {
    if (!this.subDir) return;
    let entries: string[];
    try {
      entries = (await readdir(this.subDir, { recursive: true })) as string[];
    } catch {
      return;
    }
    for (const rel of entries) {
      const m = /^agent-(.+)\.(jsonl|meta\.json)$/.exec(basename(rel));
      if (!m) continue;
      const id = m[1]!;
      const abs = join(this.subDir, rel);
      const entry = this.subs.get(id) ?? { id, meta: {}, metaResolved: false };
      if (m[2] === 'jsonl') {
        if (!entry.jsonlPath) {
          entry.jsonlPath = abs;
          entry.cursor = new LineCursor(abs, () => new TranscriptAcc());
        }
      } else if (!entry.metaPath) {
        entry.metaPath = abs;
      }
      this.subs.set(id, entry);
    }
  }

  private async advanceSub(s: SubEntry): Promise<void> {
    await Promise.all([s.cursor?.advance(), this.resolveMeta(s)]);
  }

  private async resolveMeta(s: SubEntry): Promise<void> {
    if (s.metaResolved || !s.metaPath) return;
    try {
      s.meta = JSON.parse(await readFile(s.metaPath, 'utf8'));
      s.metaResolved = true;
    } catch {
    }
  }
}

function transcriptEvents(entry: unknown, firstId: number, parentToolUseId?: string): TranscriptLogEvent[] {
  const record = asRecord(entry);
  const message = asRecord(record?.message);
  const content = message?.content;
  if (record?.type !== 'assistant' || !Array.isArray(content)) return [];
  const ts = timestamp(record.timestamp);
  const lane = parentToolUseId ? { parentToolUseId } : {};
  const events: TranscriptLogEvent[] = [];
  for (const block of content) {
    const value = asRecord(block);
    if (!value) continue;
    const id = firstId + events.length;
    if (value.type === 'text' && typeof value.text === 'string') {
      events.push({ id, seq: id, ts, type: 'session_update', payload: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value.text }, ...(parentToolUseId ? { _meta: { claudeCode: lane } } : {}) } });
    } else if (value.type === 'thinking' && typeof value.thinking === 'string') {
      events.push({ id, seq: id, ts, type: 'session_update', payload: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: value.thinking }, ...(parentToolUseId ? { _meta: { claudeCode: lane } } : {}) } });
    } else if (value.type === 'tool_use' && typeof value.id === 'string') {
      const name = typeof value.name === 'string' ? value.name : 'Tool call';
      events.push({ id, seq: id, ts, type: 'session_update', payload: { sessionUpdate: 'tool_call', toolCallId: value.id, title: withTarget(name, value.input), status: 'completed', _meta: { claudeCode: { toolName: name, ...lane } } } });
    }
  }
  return events;
}

async function transcriptSubagents(rootPath: string): Promise<Array<{ path: string; parentToolUseId: string }>> {
  const dir = join(dirname(rootPath), basename(rootPath, '.jsonl'), 'subagents');
  let names: string[];
  try {
    names = await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
  const found = new Map<string, { jsonl?: string; meta?: string }>();
  for (const rel of names) {
    const match = /^agent-(.+)\.(jsonl|meta\.json)$/.exec(basename(rel));
    if (!match) continue;
    const entry = found.get(match[1]!) ?? {};
    if (match[2] === 'jsonl') entry.jsonl = join(dir, rel);
    else entry.meta = join(dir, rel);
    found.set(match[1]!, entry);
  }
  const subagents: Array<{ path: string; parentToolUseId: string }> = [];
  for (const [id, { jsonl, meta }] of found) {
    if (!jsonl) continue;
    let parentToolUseId = id;
    if (meta) {
      try {
        const parsed = asRecord(JSON.parse(await readFile(meta, 'utf8')));
        if (typeof parsed?.toolUseId === 'string') parentToolUseId = parsed.toolUseId;
      } catch {
      }
    }
    subagents.push({ path: jsonl, parentToolUseId });
  }
  return subagents;
}

export const claudeAdapter: HarnessAdapter = {
  commandPrefix: '/',
  transcript: { events: transcriptEvents, subagents: transcriptSubagents },
  spawnEnv: ({ model }) => ({
    // Claude Code refuses to start nested inside another Claude Code session;
    // Harmonic itself may have been launched from one.
    CLAUDECODE: undefined,
    CLAUDE_CODE_ENTRYPOINT: undefined,
    ANTHROPIC_MODEL: model,
  }),

  // The HARMONIC_MCP_URL/HARMONIC_API_KEY env vars alone don't make Claude
  // Code load an MCP server; it has to be registered over ACP `session/new`.
  mcpServers: ({ url, token }) => [
    {
      name: 'harmonic',
      type: 'http',
      url,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    },
  ],
  unattendedPermissionMode: (available) => ['auto', 'bypassPermissions'].find((mode) => available.includes(mode)),
  requiresUnattendedPermissionMode: true,

  usage: {
    resolveTranscriptPath({ sessionLogDir, sessionId }) {
      return resolveTranscriptPath(sessionLogDir, sessionId);
    },
    /**
     * Each Subagent's `.meta.json` nests it under its parent via
     * `parentAgentId`; depth-1 Subagents and workflow/teammate agents (no
     * `parentAgentId`) hang off the root.
     *
     * ponytail: single-model-per-node — a node whose calls span models folds
     * under its dominant model; the flat `usage` keeps the true per-model
     * split. Split per node if the Activity view ever needs exact per-node
     * pricing. `parentAgentId` is the nesting join (present exactly at
     * depth ≥2); the `.meta.json` `toolUseId` → parent `Agent` tool_use id
     * would be equivalent but needs a full tool_use scan — used here only for
     * the finished/active status.
     */
    parse(input) {
      const rootFile = claudeAdapter.usage!.sessionLogFile(input);
      if (!rootFile || !existsSync(rootFile)) return null;
      const rootScan = scanTranscript(rootFile);
      const subs = readSubagents(subagentsDir(rootFile));
      return buildParsed(input.sessionId ?? rootFile, rootScan, subs);
    },

    createTailReader(input) {
      return new ClaudeSessionTailReader(input);
    },

    /**
     * Claude Code writes `<sessionLogDir>/<slug(cwd)>/<sessionId>.jsonl`
     * where the slug replaces every non-alphanumeric character with '-',
     * and the ACP sessionId equals the log filename.
     */
    sessionLogFile({ sessionLogDir, cwd, sessionId }) {
      const logDir = sessionLogDir ?? join(homedir(), '.claude', 'projects');
      if (!logDir || !sessionId) return null;
      const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
      return join(logDir, slug, `${sessionId}.jsonl`);
    },

    modelsFromSessionLog(file) {
      return scanTranscript(file).models;
    },

    toolName(payload) {
      const name = (payload as any)?._meta?.claudeCode?.toolName;
      return typeof name === 'string' ? name : null;
    },
  },
};
