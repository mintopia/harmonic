import { execFile } from 'node:child_process';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MAP_LABEL, type Ticket, type TicketRef, type TicketState, type TrackerAdapter } from './adapter.js';

const execFileAsync = promisify(execFile);

const COMMENTS_MARK = '<!-- comments -->';

/**
 * The local-markdown Tracker Adapter (R2, issue #37). Nothing is native: each
 * ticket is a `<id>-<slug>.md` file under the configured dir (default
 * `.scratch/`), and every `Ticket` field is a convention this adapter owns.
 *
 * - **Ids are minted from the filename prefix.** `0037-foo.md` → id 37. Files
 *   with no leading integer aren't tickets and are skipped. Referential
 *   integrity of edges is the adapter's job — nothing validates a dangling ref.
 * - **Relationships are pure convention.** Frontmatter carries `parent`,
 *   `blockedBy`, `blocking` (id or id-list). `scan` synthesises them into a
 *   directional graph: a `blockedBy` on one side fills the reverse `blocking`
 *   on the other, so an edge declared from either end is complete.
 * - **`claim`/`release`/`close` are one file write each** — the git commit is
 *   left to the caller (the skills' `git`), matching the read-only-then-commit
 *   convention.
 *
 * ponytail: minimal frontmatter subset (scalars + inline `[a, b]` lists) parsed
 * inline — no YAML dep. The adapter defines the format, so it stays simple.
 */
export function localMarkdownAdapter(dir: string, opts: { identity?: string } = {}): TrackerAdapter {
  let identity: string | undefined = opts.identity;

  const parsed = async (): Promise<Parsed[]> => {
    const names = (await readdir(dir)).filter((n) => n.endsWith('.md') && /^\d+/.test(n));
    return Promise.all(
      names.map(async (name) => ({ name, ...parse(await readFile(join(dir, name), 'utf8'), idOf(name)) })),
    );
  };

  // ponytail: read-whole-dir → mutate → write, no file lock; concurrent writes to
  // one ticket race (lost update). Fine for a single-user local tracker — add a
  // per-file lock if a repo drives this concurrently.
  const rewrite = async (number: number, mutate: (fm: Frontmatter) => void, appendComment?: TicketComment) => {
    const file = (await parsed()).find((p) => p.id === number);
    if (!file) throw new Error(`local-markdown: no ticket #${number} under ${dir}`);
    mutate(file.fm);
    const comments = appendComment ? [...file.comments, appendComment] : file.comments;
    await writeFile(join(dir, file.name), serialise(file.fm, file.body, comments));
  };

  return {
    name: 'local-markdown',

    async scan() {
      return synthesise(await parsed(), dir);
    },

    async readTicket(ref: TicketRef) {
      const found = (await synthesise(await parsed(), dir)).find((t) => t.number === ref.number);
      if (!found) throw new Error(`local-markdown: no ticket #${ref.number} under ${dir}`);
      return found;
    },

    async claim(ticket: Ticket) {
      const me = await this.whoami();
      await rewrite(ticket.number, (fm) => {
        if (!fm.assignees.includes(me)) fm.assignees.push(me);
      });
    },

    async release(ticket: Ticket) {
      const me = await this.whoami();
      await rewrite(ticket.number, (fm) => {
        fm.assignees = fm.assignees.filter((a) => a !== me);
      });
    },

    async whoami() {
      if (identity !== undefined) return identity;
      return (identity = await gitUser(dir));
    },

    async close(ticket: Ticket, comment: string) {
      const me = await this.whoami();
      await rewrite(
        ticket.number,
        (fm) => {
          fm.state = 'closed';
          fm.closedAt ??= new Date().toISOString();
        },
        comment ? { author: me, body: comment, createdAt: new Date().toISOString() } : undefined,
      );
    },
  };
}

// --- id + git identity ---

const idOf = (name: string): number => parseInt(name, 10);

/** The tracker assignee `claim` writes; the foreign-assignee filter compares against it. Falls back to `harmonic`. */
async function gitUser(cwd: string): Promise<string> {
  for (const key of ['user.email', 'user.name']) {
    try {
      const { stdout } = await execFileAsync('git', ['config', key], { cwd });
      const v = stdout.trim();
      if (v) return v;
    } catch {
      /* not a repo / unset — try the next key */
    }
  }
  return 'harmonic';
}

// --- frontmatter parse / serialise ---

interface TicketComment {
  author: string;
  body: string;
  createdAt: string;
}

interface Frontmatter {
  title: string;
  state: TicketState;
  createdAt: string;
  closedAt: string | null;
  labels: string[];
  assignees: string[];
  parent: number | null;
  blockedBy: number[];
  blocking: number[];
}

interface Parsed {
  name: string;
  id: number;
  fm: Frontmatter;
  body: string;
  comments: TicketComment[];
}

/** Split `key: value`; values are bare scalars or inline `[a, b, c]` lists. */
function parseFrontmatter(block: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const v = (m[2] ?? '').trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      out[key] = v
        .slice(1, -1)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    } else {
      out[key] = v;
    }
  }
  return out;
}

const asList = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : []);
const asInt = (v: string | string[] | undefined): number | null => {
  const s = Array.isArray(v) ? v[0] : v;
  const n = s ? parseInt(s, 10) : NaN;
  return Number.isFinite(n) ? n : null;
};

function parse(raw: string, id: number): Omit<Parsed, 'name' | 'id'> & { id: number } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const fields = parseFrontmatter(m?.[1] ?? '');
  const rest = m?.[2] ?? raw;
  const [bodyRaw = '', commentsRaw = ''] = rest.split(`\n${COMMENTS_MARK}\n`);
  const fm: Frontmatter = {
    title: (fields.title as string) ?? '',
    state: fields.state === 'closed' ? 'closed' : 'open',
    createdAt: (fields.createdAt as string) ?? '',
    closedAt: (fields.closedAt as string) || null,
    labels: asList(fields.labels),
    assignees: asList(fields.assignees),
    parent: asInt(fields.parent),
    blockedBy: asList(fields.blockedBy).map((x) => parseInt(x, 10)).filter(Number.isFinite),
    blocking: asList(fields.blocking).map((x) => parseInt(x, 10)).filter(Number.isFinite),
  };
  return { id, fm, body: bodyRaw.trim(), comments: parseComments(commentsRaw) };
}

function parseComments(region: string): TicketComment[] {
  return region
    .split(/\n(?=### )/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const [head = '', ...rest] = block.split('\n');
      const m = head.replace(/^###\s*/, '').match(/^(.*?)\s+·\s+(.*)$/);
      return { author: m?.[1]?.trim() ?? '', createdAt: m?.[2]?.trim() ?? '', body: rest.join('\n').trim() };
    });
}

const list = (xs: (string | number)[]): string => `[${xs.join(', ')}]`;

/** ponytail: `<!-- comments -->` / `### author · ts` markers are literal — a body containing them mis-parses. Adapter-owned format, so we control it. */
function serialise(fm: Frontmatter, body: string, comments: TicketComment[]): string {
  const lines = [
    `title: ${fm.title}`,
    `state: ${fm.state}`,
    `createdAt: ${fm.createdAt}`,
  ];
  if (fm.closedAt) lines.push(`closedAt: ${fm.closedAt}`);
  lines.push(`labels: ${list(fm.labels)}`, `assignees: ${list(fm.assignees)}`);
  if (fm.parent !== null) lines.push(`parent: ${fm.parent}`);
  lines.push(`blockedBy: ${list(fm.blockedBy)}`, `blocking: ${list(fm.blocking)}`);
  let out = `---\n${lines.join('\n')}\n---\n\n${body}\n`;
  if (comments.length) {
    const blocks = comments.map((c) => `### ${c.author} · ${c.createdAt}\n${c.body}`).join('\n\n');
    out += `\n${COMMENTS_MARK}\n\n${blocks}\n`;
  }
  return out;
}

// --- directional edge synthesis ---

function synthesise(files: Parsed[], dir: string): Ticket[] {
  const byId = new Map(files.map((f) => [f.id, f]));
  const ref = (id: number): TicketRef | null => {
    const f = byId.get(id);
    return f ? { number: f.id, title: f.fm.title, state: f.fm.state } : null;
  };
  // Reverse-fill: a declared blockedBy implies the target blocks us, and vice versa.
  const blockedBy = new Map<number, Set<number>>(files.map((f) => [f.id, new Set(f.fm.blockedBy)]));
  const blocking = new Map<number, Set<number>>(files.map((f) => [f.id, new Set(f.fm.blocking)]));
  for (const f of files) {
    for (const b of f.fm.blockedBy) blocking.get(b)?.add(f.id);
    for (const b of f.fm.blocking) blockedBy.get(b)?.add(f.id);
  }
  const refs = (ids: Set<number>): TicketRef[] => [...ids].map(ref).filter((r): r is TicketRef => r !== null);

  return files.map((f) => ({
    number: f.id,
    title: f.fm.title,
    state: f.fm.state,
    body: f.body,
    createdAt: f.fm.createdAt,
    closedAt: f.fm.closedAt,
    labels: f.fm.labels,
    assignees: f.fm.assignees,
    parent: byId.has(f.fm.parent ?? -1) ? f.fm.parent : null,
    blockedBy: refs(blockedBy.get(f.id)!),
    blocking: refs(blocking.get(f.id)!),
    comments: f.comments,
    isMap: f.fm.labels.includes(MAP_LABEL),
    url: pathToFileURL(join(dir, f.name)).href,
  }));
}
