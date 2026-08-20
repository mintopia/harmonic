import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { open, readdir, readFile, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { dominantModel, foldModels, usageFromModels, type ParsedSession, type ProcessNode } from '../usage.js';
import type { HarnessAdapter, ModelUsage, SessionTailReader } from './adapter.js';

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

/**
 * The running fold of one `<sessionId>.jsonl` / `agent-<id>.jsonl` transcript,
 * updated line-by-line so a whole-file scan (`scanTranscript`) and an
 * incremental tail (`TranscriptCursor`, #217) share the exact accounting.
 * `seen` and `completed` persist across incremental reads, so a chunked
 * assistant message (repeated id) is deduped even when its chunks land in two
 * different ticks.
 */
class TranscriptAcc {
  readonly models: Record<string, ModelUsage> = {};
  private readonly seen = new Set<string>();
  readonly completed = new Set<string>();
  contextTokens: number | null = null;

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
  }

  snapshot(): Transcript {
    return { models: this.models, contextTokens: this.contextTokens, completed: this.completed };
  }
}

/** One whole-file pass over a transcript (the run-end `collectUsage` path). */
function scanTranscript(file: string): Transcript {
  const acc = new TranscriptAcc();
  if (!existsSync(file)) return acc.snapshot();
  for (const line of readFileSync(file, 'utf8').split('\n')) acc.fold(line);
  return acc.snapshot();
}

/**
 * An incremental line reader over one append-only transcript (#217). Each
 * `advance()` reads only the bytes appended since the previous call, off the
 * event loop, and folds the newly-completed lines into a persistent
 * `TranscriptAcc`. The trailing line after the last newline is kept as `carry`
 * and *also* folded speculatively: a real in-progress write is invalid JSON
 * that `fold` skips, while a genuinely complete final line with no trailing
 * newline (what the whole-file scan would still parse) is counted now — and
 * re-folding it once its newline arrives is a no-op, since the acc dedupes on
 * message id / line. A `StringDecoder` carries a UTF-8 multibyte sequence split
 * across a read boundary.
 */
class TranscriptCursor {
  private offset = 0;
  private carry = '';
  private decoder = new StringDecoder('utf8');
  private acc = new TranscriptAcc();

  constructor(private readonly file: string) {}

  async advance(): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.file, 'r');
      const { size } = await handle.stat();
      if (size < this.offset) this.reset(); // truncated/rotated: re-read from the top
      if (size <= this.offset) return;
      const length = size - this.offset;
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buf, 0, length, this.offset);
      this.offset += bytesRead;
      const text = this.carry + this.decoder.write(buf.subarray(0, bytesRead));
      const lastNl = text.lastIndexOf('\n');
      if (lastNl >= 0) {
        this.carry = text.slice(lastNl + 1);
        for (const line of text.slice(0, lastNl).split('\n')) this.acc.fold(line);
      } else {
        this.carry = text;
      }
      // Speculatively fold the trailing line too: a complete final line with no
      // newline is real (the whole-file scan parses it), a partial write is
      // invalid JSON `fold` drops, and the acc dedupes a later re-fold.
      if (this.carry) this.acc.fold(this.carry);
    } catch {
      // Not written yet, vanished, or a transient read error: keep what we have.
      // Never throw — a sampler must not fail a run.
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private reset(): void {
    // A shrunk file means the log was truncated or replaced (session logs are
    // append-only, so this is rare). Re-scan from scratch with a fresh acc
    // rather than folding new content onto already-counted tokens.
    this.offset = 0;
    this.carry = '';
    this.decoder = new StringDecoder('utf8');
    this.acc = new TranscriptAcc();
  }

  transcript(): Transcript {
    return this.acc.snapshot();
  }
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

/** The `<sessionId>/subagents/` dir beside a root transcript. */
function subagentsDir(rootFile: string): string {
  return join(dirname(rootFile), basename(rootFile, '.jsonl'), 'subagents');
}

/**
 * Fold a root transcript plus its recursive Subagents into rolled-up Usage +
 * the Process Tree (ADR 0009). Shared by the whole-file `parse` and the
 * incremental `ClaudeSessionTailReader` so both build an identical tree from
 * whatever `Transcript`s they were handed. See `parse`'s doc for the nesting
 * rules (`parentAgentId`, the completed-set status, depth).
 */
function buildParsed(rootId: string, rootScan: Transcript, subs: Subagent[]): ParsedSession {
  // A Subagent is finished once its spawning tool_use has a tool_result,
  // recorded in the parent (root or another Subagent) transcript.
  const completed = new Set<string>(rootScan.completed);
  for (const s of subs) for (const id of s.scan.completed) completed.add(id);

  const root: ProcessNode = {
    id: rootId,
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
}

const emptyTranscript = (): Transcript => ({ models: {}, contextTokens: null, completed: new Set<string>() });

interface SubEntry {
  id: string;
  jsonlPath?: string;
  metaPath?: string;
  cursor?: TranscriptCursor;
  meta: SubagentMeta;
  /** True once `.meta.json` parsed; a mid-run incomplete write retries next tick. */
  metaResolved: boolean;
}

/**
 * The incremental, async live reader for a claude run's session log (#217).
 * Holds a `TranscriptCursor` per file (root + each Subagent) so every tick
 * folds only newly-appended bytes instead of re-reading the whole tree, and
 * rebuilds the (cheap, O(#agents)) Process Tree from the accumulated
 * transcripts. `latest()` serves the last build to the on-demand callers
 * (Activity snapshot, spend guard) with no I/O.
 */
class ClaudeSessionTailReader implements SessionTailReader {
  private readonly rootFile: string | null;
  private readonly subDir: string | null;
  private rootCursor: TranscriptCursor | null = null;
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
    // Serialize onto the cursors: a slow tick and an on-demand read must never
    // advance the same byte offset concurrently. Chain past whatever ran last.
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
      if (!existsSync(this.rootFile)) return this.cached; // no log yet → stays null
      this.rootCursor = new TranscriptCursor(this.rootFile);
    }
    await this.discoverSubs();
    await Promise.all([this.rootCursor.advance(), ...[...this.subs.values()].map((s) => this.advanceSub(s))]);
    const subs: Subagent[] = [...this.subs.values()].map((s) => ({
      id: s.id,
      meta: s.meta,
      scan: s.cursor ? s.cursor.transcript() : emptyTranscript(),
    }));
    this.cached = buildParsed(this.input.sessionId, this.rootCursor.transcript(), subs);
    return this.cached;
  }

  /** Pick up Subagent files that have appeared since the last tick. */
  private async discoverSubs(): Promise<void> {
    if (!this.subDir) return;
    let entries: string[];
    try {
      entries = (await readdir(this.subDir, { recursive: true })) as string[];
    } catch {
      return; // no subagents dir this run
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
          entry.cursor = new TranscriptCursor(abs);
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
      /* incomplete write mid-run: keep default meta, retry next tick */
    }
  }
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
      const subs = readSubagents(subagentsDir(rootFile));
      return buildParsed(input.sessionId ?? rootFile, rootScan, subs);
    },

    /** The live path (#217): an incremental, off-the-event-loop tailer that
     *  folds only newly-appended bytes each tick, versus `parse`'s whole-file
     *  re-read (kept for the one-shot run-end `collectUsage`). */
    createTailReader(input) {
      return new ClaudeSessionTailReader(input);
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
