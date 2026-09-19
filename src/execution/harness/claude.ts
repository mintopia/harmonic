import { readFileSync, existsSync } from 'node:fs';
import { access, readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { dominantModel, foldModels, usageFromModels, type ParsedSession, type ProcessNode, type UsageTurn } from '../usage.js';
import { resolveUnattendedPermissionMode, serializedTailReader, type HarnessAdapter, type ModelUsage, type SessionTailReader } from './adapter.js';
import { LineCursor, type LineAccumulator } from './incremental-log.js';
import { num, addModelUsage } from './model-usage.js';
import { agentFiles, agentFilesSync, isTraversalSafeSegment } from './session-files.js';
import { asRecord, timestamp, withTarget, type TranscriptLogEvent } from './transcript.js';

function mergeInto(dest: Record<string, ModelUsage>, src: Record<string, ModelUsage>): void {
  for (const [model, usage] of Object.entries(src)) addModelUsage(dest, model, usage);
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
  const subs: Subagent[] = [];
  for (const { id, jsonl, meta } of agentFilesSync(subDir).values()) {
    let parsed: SubagentMeta = {};
    if (meta) {
      try {
        parsed = JSON.parse(readFileSync(meta, 'utf8'));
      } catch {
      }
    }
    subs.push({ id, meta: parsed, scan: jsonl ? scanTranscript(jsonl) : emptyTranscript() });
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
  if (!isTraversalSafeSegment(sessionId)) return null;
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

function claudeTailReader(input: { sessionLogDir?: string | undefined; cwd: string; sessionId: string }): SessionTailReader {
  const rootFile = claudeAdapter.usage!.sessionLogFile(input);
  const subDir = rootFile ? subagentsDir(rootFile) : null;
  let rootCursor: LineCursor<TranscriptAcc> | null = null;
  const subs = new Map<string, SubEntry>();

  const resolveMeta = async (s: SubEntry): Promise<void> => {
    if (s.metaResolved || !s.metaPath) return;
    try {
      s.meta = JSON.parse(await readFile(s.metaPath, 'utf8'));
      s.metaResolved = true;
    } catch {
    }
  };

  const advanceSub = async (s: SubEntry): Promise<void> => {
    await Promise.all([s.cursor?.advance(), resolveMeta(s)]);
  };

  const discoverSubs = async (): Promise<void> => {
    if (!subDir) return;
    for (const { id, jsonl, meta } of (await agentFiles(subDir)).values()) {
      const entry = subs.get(id) ?? { id, meta: {}, metaResolved: false };
      if (jsonl && !entry.jsonlPath) {
        entry.jsonlPath = jsonl;
        entry.cursor = new LineCursor(jsonl, () => new TranscriptAcc());
      }
      if (meta && !entry.metaPath) entry.metaPath = meta;
      subs.set(id, entry);
    }
  };

  return serializedTailReader(async (previous) => {
    if (!rootFile) return null;
    if (!rootCursor) {
      if (!existsSync(rootFile)) return previous;
      rootCursor = new LineCursor(rootFile, () => new TranscriptAcc());
    }
    await discoverSubs();
    await Promise.all([rootCursor.advance(), ...[...subs.values()].map((s) => advanceSub(s))]);
    const built: Subagent[] = [...subs.values()].map((s) => ({
      id: s.id,
      meta: s.meta,
      scan: s.cursor ? s.cursor.acc.snapshot() : emptyTranscript(),
    }));
    return buildParsed(input.sessionId, rootCursor.acc.snapshot(), built);
  });
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
  const dir = subagentsDir(rootPath);
  const subagents: Array<{ path: string; parentToolUseId: string }> = [];
  for (const { id, jsonl, meta } of (await agentFiles(dir)).values()) {
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
  permissionModes: { auto: 'Auto', bypassPermissions: 'Bypass Permissions' },
  defaultPermissionMode: 'auto',
  unattendedPermissionMode: (available, configured) =>
    resolveUnattendedPermissionMode({
      available,
      configured,
      permissionModes: claudeAdapter.permissionModes ?? {},
      defaultPermissionMode: claudeAdapter.defaultPermissionMode,
    }),
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

    createTailReader: claudeTailReader,

    /**
     * Claude Code writes `<sessionLogDir>/<slug(cwd)>/<sessionId>.jsonl`
     * where the slug replaces every non-alphanumeric character with '-',
     * and the ACP sessionId equals the log filename.
     */
    sessionLogFile({ sessionLogDir, cwd, sessionId }) {
      const logDir = sessionLogDir ?? join(homedir(), '.claude', 'projects');
      if (!logDir || !sessionId) return null;
      if (!isTraversalSafeSegment(sessionId)) return null;
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
