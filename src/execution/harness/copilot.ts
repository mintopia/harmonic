import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dominantModel, foldModels, usageFromModels, type ParsedSession, type ProcessNode, type ProcessStatus } from '../usage.js';
import type { HarnessAdapter, ModelUsage } from './adapter.js';

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * Copilot's Usage lives in its native store `<home>/session-store.db`: the
 * `assistant_usage_events` table carries per-turn tokens, AI Units
 * (`total_nano_aiu`), and Subagent attribution (`parent_tool_call_id`).
 */
function copilotHome(sessionLogDir: string | undefined): string {
  return sessionLogDir ?? join(homedir(), '.copilot');
}

interface UsageRow {
  parent_tool_call_id: string | null;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_nano_aiu: number | null;
}

function readUsageRows(dbPath: string, sessionId: string): UsageRow[] {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db
        .prepare(
          `SELECT parent_tool_call_id, model, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_tokens, total_nano_aiu
             FROM assistant_usage_events WHERE session_id = ? ORDER BY id`,
        )
        .all(sessionId) as unknown as UsageRow[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * Copilot's `input_tokens` column is TOTAL input; the cache columns are
 * subtracted to keep ModelUsage's uncached-input convention.
 */
function rowsToModels(rows: UsageRow[]): Record<string, ModelUsage> {
  const models: Record<string, ModelUsage> = {};
  const nano: Record<string, number> = {};
  for (const r of rows) {
    const bucket = (models[r.model] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const cacheRead = num(r.cache_read_tokens);
    const cacheWrite = num(r.cache_write_tokens);
    bucket.inputTokens += Math.max(0, num(r.input_tokens) - cacheRead - cacheWrite);
    bucket.outputTokens += num(r.output_tokens);
    bucket.cacheReadTokens += cacheRead;
    bucket.cacheWriteTokens += cacheWrite;
    if (typeof r.total_nano_aiu === 'number') nano[r.model] = (nano[r.model] ?? 0) + r.total_nano_aiu;
  }
  for (const [model, units] of Object.entries(nano)) models[model]!.aiUnits = units / 1e9;
  return models;
}

interface SubagentInfo {
  name: string;
  model?: string;
  status: ProcessStatus;
}

/**
 * Live Subagent status from `events.jsonl`: `subagent.started` (active) →
 * `subagent.completed`/`failed` (inactive). `toolCallId` is the DB's
 * `parent_tool_call_id`, joining a Subagent's usage rows to its name/status.
 */
function readSubagents(eventsFile: string): Map<string, SubagentInfo> {
  const map = new Map<string, SubagentInfo>();
  if (!existsSync(eventsFile)) return map;
  for (const line of readFileSync(eventsFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const data = event?.data;
    const id = data?.toolCallId;
    if (typeof id !== 'string') continue;
    const name = data.agentName ?? data.agentDisplayName ?? 'subagent';
    if (event.type === 'subagent.started') {
      map.set(id, { name, status: 'active' });
    } else if (event.type === 'subagent.completed' || event.type === 'subagent.failed') {
      const prev = map.get(id);
      map.set(id, {
        name: prev?.name ?? name,
        model: typeof data.model === 'string' ? data.model : prev?.model,
        status: 'inactive',
      });
    }
  }
  return map;
}

export const copilotAdapter: HarnessAdapter = {
  commandPrefix: '/',
  transcript: null,
  // Copilot ignores --model and COPILOT_MODEL in --acp mode, and --model
  // falsifies session/new's reported currentModelId without changing the
  // session. The CLI also updates itself mid-run unless told not to.
  spawnEnv: () => ({ COPILOT_AUTO_UPDATE: 'false' }),
  unattendedPermissionMode: (available) => ['auto', 'bypassPermissions'].find((mode) => available.includes(mode)),
  requiresUnattendedPermissionMode: true,

  // Sent for every run, 'auto' included: an unpinned Copilot ACP session
  // inherits the operator's persisted settings.json model, not auto.
  sessionModelId: (model) => model,

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
     * Root node = the main agent's rows (`parent_tool_call_id` null); each
     * Subagent = the rows sharing a spawning tool-call id, named and
     * status-flagged from `events.jsonl`.
     *
     * ponytail: single-model-per-node — Copilot's `auto` router serves
     * several models within one node, folded here under the node's
     * dominant model. The flat `usage` keeps the true per-model split;
     * only the tree node is lossy. Split per model if the Activity view
     * ever needs exact per-node pricing.
     *
     * ponytail: one-level tree keyed by `parent_tool_call_id` — every
     * observed Subagent is a direct child of the root (`agent_id` is null
     * in all captured rows, and `events.jsonl` chains Subagents flatly by
     * `toolCallId`). Attribute deeper nesting via `agent_id` if Copilot
     * ever spawns Subagents-of-Subagents; ProcessNode is already recursive.
     *
     * ponytail: no `createTailReader` (#217) — deliberately stays on the
     * whole-file `wholeFileReader` fallback. Usage lives in a sqlite store read
     * through node:sqlite's `DatabaseSync`, which is *synchronous*, so there's
     * nothing to move off the event loop the way an async byte-cursor does for claude/codex;
     * and the read is already a bounded, indexed `WHERE session_id = ?` query
     * (a session's rows, not an unbounded whole-file re-parse), so it isn't the
     * O(total) cost #217 targets. A rowid cursor would add real state for no
     * event-loop win. Revisit only if a session's row count ever gets large
     * enough that the per-tick query shows up in a profile.
     */
    parse(input) {
      const { sessionId } = input;
      if (!sessionId) return null;
      const home = copilotHome(input.sessionLogDir);
      const rows = readUsageRows(join(home, 'session-store.db'), sessionId);
      const subagents = readSubagents(join(home, 'session-state', sessionId, 'events.jsonl'));
      if (rows.length === 0 && subagents.size === 0) return null;

      const byParent = new Map<string, UsageRow[]>();
      for (const row of rows) {
        if (row.parent_tool_call_id == null) continue;
        const list = byParent.get(row.parent_tool_call_id) ?? [];
        list.push(row);
        byParent.set(row.parent_tool_call_id, list);
      }

      const node = (id: string, name: string, rs: UsageRow[], depth: number, info?: SubagentInfo): ProcessNode => {
        const models = rowsToModels(rs);
        return {
          id,
          name,
          model: dominantModel(models) ?? info?.model ?? 'unknown',
          usage: foldModels(models),
          contextTokens: rs.length ? num(rs[rs.length - 1]!.input_tokens) : null,
          lastTool: null,
          status: info?.status ?? 'active',
          depth,
          toolUseId: depth === 0 ? null : id,
          children: [],
        };
      };

      const childIds = new Set<string>([...byParent.keys(), ...subagents.keys()]);
      const children = [...childIds].map((id) =>
        node(id, subagents.get(id)?.name ?? 'subagent', byParent.get(id) ?? [], 1, subagents.get(id)),
      );

      const root = node(sessionId, 'root', rows.filter((r) => r.parent_tool_call_id == null), 0);
      root.children = children;
      return { usage: usageFromModels(rowsToModels(rows)), tree: root } satisfies ParsedSession;
    },

    sessionLogFile({ sessionLogDir, sessionId }) {
      if (!sessionId) return null;
      return join(copilotHome(sessionLogDir), 'session-store.db');
    },

    modelsFromSessionLog(file, sessionId) {
      if (!sessionId) return {};
      return rowsToModels(readUsageRows(file, sessionId));
    },

    toolName() {
      return null;
    },
  },
};
