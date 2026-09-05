import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { dominantModel, foldModels, usageFromModels, type ParsedSession, type ProcessNode } from '../usage.js';
import type { HarnessAdapter, ModelUsage } from './adapter.js';
import { withTarget, type TranscriptLogEvent } from './transcript.js';
import type { ModelPrice } from '../../domain/pricing.js';

type JsonRecord = Record<string, unknown>;

const modelsFile = () => join(homedir(), '.cache', 'opencode', 'models.json');
const authFile = () => join(homedir(), '.local', 'share', 'opencode', 'auth.json');
const usageFile = (sessionLogDir: string | undefined) => join(sessionLogDir ?? homedir(), '.local', 'share', 'opencode', 'opencode.db');

interface SessionRow {
  id: string;
  parent_id: string | null;
  agent: string | null;
}

interface UsageRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface UsageSession {
  session: SessionRow;
  rows: UsageRow[];
}

const tokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

function sessionRow(value: unknown): SessionRow | null {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) return null;
  const parentId = value.parent_id;
  const agent = value.agent;
  if (parentId !== null && parentId !== undefined && typeof parentId !== 'string') return null;
  if (agent !== null && agent !== undefined && typeof agent !== 'string') return null;
  return { id: value.id, parent_id: parentId ?? null, agent: agent ?? null };
}

function usageRow(value: unknown): UsageRow | null {
  let message: unknown = value;
  if (typeof message === 'string') {
    try {
      message = JSON.parse(message);
    } catch {
      return null;
    }
  }
  if (!isRecord(message) || message.role !== 'assistant' || !isRecord(message.tokens)) return null;
  const provider = typeof message.providerID === 'string' ? message.providerID : null;
  const model = typeof message.modelID === 'string' ? message.modelID : null;
  if (!provider || !model) return null;
  const cache = isRecord(message.tokens.cache) ? message.tokens.cache : {};
  return {
    model: `${provider}/${model}`,
    inputTokens: tokenCount(message.tokens.input),
    outputTokens: tokenCount(message.tokens.output),
    cacheReadTokens: tokenCount(cache.read),
    cacheWriteTokens: tokenCount(cache.write),
  };
}

function readUsageSessions(dbPath: string, sessionId: string): UsageSession[] {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const root = sessionRow(db.prepare('SELECT id, parent_id, agent FROM session WHERE id = ?').get(sessionId));
      if (!root) return [];
      const children = db.prepare('SELECT id, parent_id, agent FROM session WHERE parent_id = ?');
      const messages = db.prepare('SELECT data FROM message WHERE session_id = ? ORDER BY time_created, id');
      const sessions: UsageSession[] = [];
      const pending = [root];
      const seen = new Set<string>();
      while (pending.length > 0) {
        const session = pending.pop()!;
        if (seen.has(session.id)) continue;
        seen.add(session.id);
        const rows = messages
          .all(session.id)
          .flatMap((message) => (isRecord(message) ? [usageRow(message.data)] : []))
          .filter((row): row is UsageRow => row !== null);
        sessions.push({ session, rows });
        pending.push(
          ...children.all(session.id).flatMap((child) => {
            const parsed = sessionRow(child);
            return parsed && !seen.has(parsed.id) ? [parsed] : [];
          }),
        );
      }
      return sessions;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function rowsToModels(rows: readonly UsageRow[]): Record<string, ModelUsage> {
  const models: Record<string, ModelUsage> = {};
  for (const row of rows) {
    const usage = (models[row.model] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    usage.inputTokens += row.inputTokens;
    usage.outputTokens += row.outputTokens;
    usage.cacheReadTokens += row.cacheReadTokens;
    usage.cacheWriteTokens += row.cacheWriteTokens;
  }
  return models;
}

function processNode(session: UsageSession, depth: number, children: ProcessNode[]): ProcessNode {
  const models = rowsToModels(session.rows);
  const latest = session.rows.at(-1);
  return {
    id: session.session.id,
    name: depth === 0 ? 'root' : stringValue(session.session.agent, 'subagent'),
    model: dominantModel(models) ?? 'unknown',
    usage: foldModels(models),
    contextTokens: latest ? latest.inputTokens + latest.cacheReadTokens + latest.cacheWriteTokens : null,
    lastTool: null,
    status: 'inactive',
    depth,
    toolUseId: null,
    children,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function priceFrom(value: unknown): ModelPrice | undefined {
  if (!isRecord(value)) return undefined;
  const input = nonnegativeNumber(value.input);
  const output = nonnegativeNumber(value.output);
  const cacheRead = nonnegativeNumber(value.cache_read);
  const cacheWrite = nonnegativeNumber(value.cache_write);
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) {
    return undefined;
  }
  return { input, output, cacheRead, cacheWrite };
}

async function readJson(path: string): Promise<JsonRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function localMetadata(): Promise<{ providers: JsonRecord; auth: JsonRecord } | null> {
  const [providers, auth] = await Promise.all([readJson(modelsFile()), readJson(authFile())]);
  return providers ? { providers, auth: auth ?? {} } : null;
}

const capabilities = {
  async selectProvider() {
    const metadata = await localMetadata();
    if (!metadata) return [];

    return Object.entries(metadata.providers).flatMap(([id, provider]) => {
      if (!isRecord(provider) || (id !== 'opencode' && !isRecord(metadata.auth[id]))) return [];
      return [{ id, label: stringValue(provider.name, id), authed: id !== 'opencode' }];
    });
  },

  async selectModel(providerId: string) {
    const metadata = await localMetadata();
    const provider = metadata?.providers[providerId];
    if (!metadata || !isRecord(provider) || (providerId !== 'opencode' && !isRecord(metadata.auth[providerId]))) return [];
    if (!isRecord(provider.models)) return [];

    return Object.entries(provider.models).flatMap(([id, model]) => {
      if (!isRecord(model)) return [];
      const contextWindow = isRecord(model.limit) ? positiveInteger(model.limit.context) : undefined;
      const price = priceFrom(model.cost);
      return [{
        id: `${providerId}/${id}`,
        label: stringValue(model.name, id),
        ...(price ? { price } : {}),
        ...(contextWindow ? { contextWindow } : {}),
      }];
    });
  },
};

const EXPORT_MAX_BYTES = 16 * 1024 * 1024;
const EXPORT_MAX_EVENTS = 2000;

function messageCreatedAt(info: unknown): number {
  const time = isRecord(info) && isRecord(info.time) ? info.time : {};
  return typeof time.created === 'number' ? time.created : 0;
}

/** OpenCode tools key their path as `filePath`, which `withTarget`'s generic
 * keys (snake_case) miss; prefer it, then fall back to the shared logic. */
function toolTitle(tool: string, input: unknown): string {
  const record = isRecord(input) ? input : null;
  const filePath = record && typeof record.filePath === 'string' ? record.filePath : null;
  return filePath ? `${tool} ${filePath}` : withTarget(tool, input);
}

/**
 * Map one `opencode export` message part to an ACP `session/update` payload the
 * transcript renderer already understands (agent text, reasoning as thought,
 * tool calls with their output, edits as a `patch` tool call). Matches the
 * assistant-only shape the Claude native reader emits; user turns surface via
 * the operator-message merge in the endpoint.
 */
export function exportEvents(json: unknown): TranscriptLogEvent[] {
  const root = isRecord(json) ? json : null;
  const messages = root && Array.isArray(root.messages) ? root.messages : [];
  const events: TranscriptLogEvent[] = [];
  const push = (ts: number, payload: Record<string, unknown>): void => {
    const id = events.length + 1;
    events.push({ id, seq: id, ts, type: 'session_update', payload });
  };
  for (const message of messages) {
    const record = isRecord(message) ? message : null;
    if (!record || !isRecord(record.info) || record.info.role !== 'assistant') continue;
    const ts = messageCreatedAt(record.info);
    for (const part of Array.isArray(record.parts) ? record.parts : []) {
      const value = isRecord(part) ? part : null;
      if (!value) continue;
      if (value.type === 'text' && typeof value.text === 'string' && value.text.trim()) {
        push(ts, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value.text } });
      } else if (value.type === 'reasoning' && typeof value.text === 'string' && value.text.trim()) {
        push(ts, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: value.text } });
      } else if (value.type === 'tool') {
        const state = isRecord(value.state) ? value.state : {};
        const tool = typeof value.tool === 'string' ? value.tool : 'Tool call';
        const output = typeof state.output === 'string' && state.output.trim() ? state.output : null;
        push(ts, {
          sessionUpdate: 'tool_call',
          ...(typeof value.callID === 'string' ? { toolCallId: value.callID } : {}),
          title: toolTitle(tool, state.input),
          status: state.status === 'error' ? 'failed' : 'completed',
          _meta: { opencode: { toolName: tool } },
          ...(output ? { content: [{ type: 'content', content: { type: 'text', text: output } }] } : {}),
        });
      } else if (value.type === 'patch') {
        const files = Array.isArray(value.files) ? value.files.filter((f): f is string => typeof f === 'string') : [];
        push(ts, {
          sessionUpdate: 'tool_call',
          ...(typeof value.id === 'string' ? { toolCallId: value.id } : {}),
          title: files.length ? `patch ${files.map((file) => basename(file)).join(', ')}` : 'patch',
          status: 'completed',
          _meta: { opencode: { toolName: 'patch' } },
        });
      }
    }
  }
  return events.slice(-EXPORT_MAX_EVENTS);
}

/**
 * Run `opencode export <sessionId>` and return its parsed JSON, or null on any
 * failure. The child writes to a temp file, not a pipe: `opencode export`
 * truncates piped stdout at the 64KB OS pipe buffer, but flushes a file fd in
 * full.
 */
function runExport(sessionId: string): Promise<unknown> {
  return new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-oc-export-'));
    const out = join(dir, 'export.json');
    const fd = openSync(out, 'w');
    const finish = (parsed: unknown): void => {
      try {
        closeSync(fd);
      } catch {
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
      }
      resolve(parsed);
    };
    const child = spawn('opencode', ['export', sessionId], { stdio: ['ignore', fd, 'ignore'] });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) return finish(null);
      try {
        if (statSync(out).size > EXPORT_MAX_BYTES) return finish(null);
        finish(JSON.parse(readFileSync(out, 'utf8')));
      } catch {
        finish(null);
      }
    });
  });
}

export const opencodeAdapter: HarnessAdapter = {
  commandPrefix: '/',
  transcript: null,
  async exportTranscript({ sessionId }) {
    if (!sessionId) return null;
    const events = exportEvents(await runExport(sessionId));
    return events.length ? events : null;
  },
  spawnEnv: ({ unattended }) =>
    unattended ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: 'allow' }) } : {},
  sessionModelId: (model) => model,
  mcpServers: ({ url, token }) => [
    {
      name: 'harmonic',
      type: 'http',
      url,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }],
    },
  ],
  unattendedPermissionMode: () => undefined,
  requiresUnattendedPermissionMode: false,
  usage: {
    parse(input) {
      if (!input.sessionId) return null;
      const sessions = readUsageSessions(usageFile(input.sessionLogDir), input.sessionId);
      const root = sessions.find((item) => item.session.id === input.sessionId);
      if (!root) return null;
      const byParent = new Map<string, UsageSession[]>();
      for (const session of sessions) {
        if (!session.session.parent_id) continue;
        const children = byParent.get(session.session.parent_id) ?? [];
        children.push(session);
        byParent.set(session.session.parent_id, children);
      }
      const tree = (session: UsageSession, depth: number, ancestors: ReadonlySet<string>): ProcessNode => {
        const nextAncestors = new Set(ancestors).add(session.session.id);
        return processNode(
          session,
          depth,
          (byParent.get(session.session.id) ?? [])
            .filter((child) => !nextAncestors.has(child.session.id))
            .map((child) => tree(child, depth + 1, nextAncestors)),
        );
      };
      return {
        usage: usageFromModels(rowsToModels(sessions.flatMap((session) => session.rows))),
        tree: tree(root, 0, new Set()),
      } satisfies ParsedSession;
    },

    sessionLogFile({ sessionLogDir, sessionId }) {
      return sessionId ? usageFile(sessionLogDir) : null;
    },

    modelsFromSessionLog(file, sessionId) {
      return sessionId ? rowsToModels(readUsageSessions(file, sessionId).flatMap((session) => session.rows)) : {};
    },

    toolName() {
      return null;
    },
  },
  capabilities,
};
