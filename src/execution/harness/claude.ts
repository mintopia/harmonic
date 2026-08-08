import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { dominantModel, foldModels, usageFromModels, type ParsedSession, type ProcessNode } from '../usage.js';
import type { HarnessAdapter, ModelUsage } from './adapter.js';

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
  /** Latest assistant message's input-side footprint (inputs + cache) — the window fill. */
  contextTokens: number | null;
  /** tool_use ids that received a tool_result here — a spawned Subagent that has finished. */
  completed: Set<string>;
}

/** One pass over a `<sessionId>.jsonl` / `agent-<id>.jsonl` transcript. */
function scanTranscript(file: string): Transcript {
  const models: Record<string, ModelUsage> = {};
  const seen = new Set<string>();
  const completed = new Set<string>();
  let contextTokens: number | null = null;
  if (!existsSync(file)) return { models, contextTokens, completed };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message;
    if (Array.isArray(message?.content)) {
      for (const block of message.content) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') completed.add(block.tool_use_id);
      }
    }
    if (entry?.type !== 'assistant' || !message?.model || !message?.usage) continue;
    const key = typeof message.id === 'string' ? message.id : line;
    if (seen.has(key)) continue;
    seen.add(key);
    const u = message.usage;
    const bucket = (models[message.model] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    bucket.inputTokens += num(u.input_tokens);
    bucket.outputTokens += num(u.output_tokens);
    bucket.cacheReadTokens += num(u.cache_read_input_tokens);
    bucket.cacheWriteTokens += num(u.cache_creation_input_tokens);
    contextTokens = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
  }
  return { models, contextTokens, completed };
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
 * Every Subagent under `<sessionId>/subagents/`, walked recursively so
 * nested spawns and workflow agents (`workflows/wf_<id>`) are all included.
 * A Subagent is a `agent-<id>.jsonl` transcript plus its `.meta.json`
 * sidecar; either can appear before the other mid-run, so a stem with only
 * one of the pair is still returned (empty usage / default meta).
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
        /* incomplete write mid-run: default meta */
      }
    }
    subs.push({ id, meta: parsed, scan: jsonl ? scanTranscript(jsonl) : { models: {}, contextTokens: null, completed: new Set() } });
  }
  return subs;
}

export const claudeAdapter: HarnessAdapter = {
  spawnEnv: ({ model }) => ({
    // The adapter refuses to start nested inside a Claude Code session
    // (spike finding); Harmonic itself may have been launched from one.
    CLAUDECODE: undefined,
    CLAUDE_CODE_ENTRYPOINT: undefined,
    ANTHROPIC_MODEL: model,
  }),

  // Register Harmonic's MCP server over ACP `session/new`, same as codex
  // and copilot — the HARMONIC_MCP_URL/HARMONIC_API_KEY env vars alone
  // don't make Claude Code load an MCP server, so an empty list left the
  // agent with no `harmonic` tools at all.
  mcpServers: ({ url, token }) => [
    {
      name: 'harmonic',
      type: 'http',
      url,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    },
  ],

  usage: {
    /**
     * Parse the session transcript plus every Subagent under
     * `<sessionId>/subagents/` (recursively — nested spawns and
     * `workflows/wf_<id>` included) into rolled-up Usage + the Process Tree
     * (ADR 0009). Each Subagent's `.meta.json` nests it under its parent via
     * `parentAgentId` (the spawning agent's `agentId`); depth-1 Subagents and
     * workflow/teammate agents (no `parentAgentId`) hang off the root. The
     * flat `usage` sums the whole tree — Subagent tokens now count toward the
     * Run, the undercount fix (#48). Returns null when no transcript exists.
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
      const subDir = join(dirname(rootFile), basename(rootFile, '.jsonl'), 'subagents');
      const subs = readSubagents(subDir);

      // A Subagent is finished once its spawning tool_use has a tool_result,
      // recorded in the parent (root or another Subagent) transcript.
      const completed = new Set<string>(rootScan.completed);
      for (const s of subs) for (const id of s.scan.completed) completed.add(id);

      const root: ProcessNode = {
        id: input.sessionId ?? rootFile,
        name: 'root',
        model: dominantModel(rootScan.models) ?? 'unknown',
        usage: foldModels(rootScan.models),
        contextTokens: rootScan.contextTokens,
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
      return { usage: usageFromModels(rolled), tree: root } satisfies ParsedSession;
    },

    /**
     * Claude Code writes `<sessionLogDir>/<slug(cwd)>/<sessionId>.jsonl`
     * where the slug replaces every non-alphanumeric character with '-',
     * and the ACP sessionId equals the log filename (spike finding).
     */
    sessionLogFile({ sessionLogDir, cwd, sessionId }) {
      const logDir = sessionLogDir ?? join(homedir(), '.claude', 'projects');
      if (!logDir || !sessionId) return null;
      const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
      return join(logDir, slug, `${sessionId}.jsonl`);
    },

    /**
     * Per-model usage from the parent transcript alone (the generic
     * `collectUsage` fallback); `parse` rolls in Subagents for the tree.
     */
    modelsFromSessionLog(file) {
      return scanTranscript(file).models;
    },

    toolName(payload) {
      const name = (payload as any)?._meta?.claudeCode?.toolName;
      return typeof name === 'string' ? name : null;
    },
  },
};
