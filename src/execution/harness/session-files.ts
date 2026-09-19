import { readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Directory entries sorted newest-first by name; an unreadable dir yields none. */
function entriesNewestFirst(dir: string): string[] {
  try {
    return readdirSync(dir).sort().reverse();
  } catch {
    return [];
  }
}

/**
 * Lazily walk a `<root>/<YYYY>/<MM>/<DD>/` log tree newest-first, yielding the
 * absolute path of every file whose basename satisfies `match`. Lazy so a
 * caller looking for one file stops the walk on the first hit.
 */
export function* datedLogFiles(root: string, match: (name: string) => boolean): Generator<string> {
  for (const year of entriesNewestFirst(root)) {
    for (const month of entriesNewestFirst(join(root, year))) {
      for (const day of entriesNewestFirst(join(root, year, month))) {
        for (const file of entriesNewestFirst(join(root, year, month, day))) {
          if (match(file)) yield join(root, year, month, day, file);
        }
      }
    }
  }
}

/** One `agent-<id>` pair under a Claude subagents dir; either half can be missing mid-run. */
export interface AgentFilePair {
  id: string;
  jsonl?: string;
  meta?: string;
}

const agentFileName = /^agent-(.+)\.(jsonl|meta\.json)$/;

/**
 * Group `agent-<id>.jsonl` / `agent-<id>.meta.json` absolute file paths by
 * id. Claude Code writes the pair non-atomically, so a stem with only one
 * half is still returned. Pairing keeps the last occurrence of a duplicate
 * id.
 */
function pairAgentFiles(entries: readonly string[]): Map<string, AgentFilePair> {
  const found = new Map<string, AgentFilePair>();
  for (const abs of entries) {
    const m = agentFileName.exec(basename(abs));
    if (!m) continue;
    const id = m[1]!;
    const entry = found.get(id) ?? { id };
    if (m[2] === 'jsonl') entry.jsonl = abs;
    else entry.meta = abs;
    found.set(id, entry);
  }
  return found;
}

/**
 * Group `agent-<id>.jsonl` / `agent-<id>.meta.json` files under `dir`
 * (recursive) by id. A missing/unreadable dir yields an empty map.
 */
export function agentFilesSync(dir: string): Map<string, AgentFilePair> {
  try {
    const entries = readdirSync(dir, { recursive: true }) as string[];
    return pairAgentFiles(entries.map((rel) => join(dir, rel)));
  } catch {
    return new Map();
  }
}

/**
 * Group `agent-<id>.jsonl` / `agent-<id>.meta.json` files under `dir`
 * (recursive) by id. A missing/unreadable dir yields an empty map.
 */
export async function agentFiles(dir: string): Promise<Map<string, AgentFilePair>> {
  try {
    const entries = (await readdir(dir, { recursive: true })) as string[];
    return pairAgentFiles(entries.map((rel) => join(dir, rel)));
  } catch {
    return new Map();
  }
}

/** Guards a sessionId-derived path segment against path traversal. */
export function isTraversalSafeSegment(value: string): boolean {
  return value.length > 0 && value !== '.' && value !== '..' && !value.includes('/') && !value.includes('\\') && !value.includes('\0');
}
