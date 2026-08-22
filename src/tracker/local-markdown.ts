import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { basename, join } from 'node:path';
import { type Ticket, type TicketRef, type TicketState, type WritableTrackerAdapter } from './adapter.js';

/** A `**Status:**` word that means the ticket is done. */
const CLOSED_STATUS = /\b(done|closed|complete|completed|merged|shipped)\b/i;
/**
 * A `**Status:**` word that explicitly means the ticket is *open* — the lifecycle
 * marker {@link WritableTrackerAdapter.reopen} writes (`open`; `reopened` for
 * symmetry). This is authoritative over the ticked-boxes heuristic: a human who
 * reopens a ticket whose acceptance boxes are all still ticked must see it parse
 * `open`, else reopen is a no-op and the premature-close→reopen path churns
 * (#237). Work-queue states like `ready-for-agent` are deliberately NOT open
 * markers — for those, all boxes ticked still closes the ticket.
 */
const OPEN_STATUS = /\b(open|reopened)\b/i;
const STATUS_FIELD = /^\s*\*\*Status:\*\*\s*.*$/im;

/** The reserved local id for a feature's `spec.md` Map. Issue filenames start at `01`, so `0` never collides. */
const SPEC_ID = 0;

/**
 * Per-feature id namespace, so tickets stay unique across coexisting feature
 * specs. A feature's ids are `base + <local NN>`, base a distinct multiple of
 * STRIDE. A feature is capped at STRIDE-1 tickets. The single-feature case keeps
 * base 0 (bare `NN`, spec `0`). For coexisting features the base is derived from
 * the feature dir's **name**, not its sorted position ({@link assignBases}) —
 * position is unstable: adding an earlier-sorting feature would otherwise
 * renumber existing features *and* hand the new one the freed low refs, which a
 * consumer keying on the ticket `number` reads as already-seen work. A
 * name-derived base is stable under any sibling insertion.
 */
const STRIDE = 10000;

/**
 * Resolves a feature slug to its stable id **index** (0, 1, 2, …); its base is
 * `index * STRIDE`. Harmonic injects a DB-backed, assign-once (first-seen)
 * implementation so a feature's index never shifts when a sibling is added —
 * see `TaskService.mdFeatureIndex`. Absent (standalone reads), the adapter
 * falls back to sorted position.
 */
export type FeatureIndex = (slug: string) => Promise<number>;

/**
 * Each feature scope's id base — a distinct multiple of STRIDE. The single-feature
 * layout keeps base 0 (bare `NN`, spec `0`). For coexisting features the base is
 * `index(slug) * STRIDE`. That index must be **stable per feature name across
 * scans**: the mirror keys a ticket by its `number` for dedup, so a base that
 * shifts when a sibling dir is added would recycle old refs onto new work (or
 * hide new work as already-seen). Harmonic supplies a persistent `featureIndex`;
 * standalone falls back to sorted position — deterministic for a one-shot read,
 * but not stable across insertions (no store to remember prior assignments).
 */
async function assignBases(scopes: Scope[], featureIndex?: FeatureIndex): Promise<number[]> {
  // The unnamed single-feature layout (issues/ or root directly) → clean base 0.
  // A *named* feature always goes through featureIndex even when it's currently
  // the only one, so its index is recorded now and survives a later sibling —
  // otherwise the sibling (sorted first) would claim index 0 and renumber it.
  if (scopes.length === 1 && scopes[0]!.slug === '') return [0];
  const bases: number[] = [];
  // Sequential (not Promise.all): each first-seen slug's index is assigned by
  // reading the prior count, so the persistent featureIndex must observe earlier
  // siblings' assignments before numbering the next.
  for (let i = 0; i < scopes.length; i++) {
    bases.push((featureIndex ? await featureIndex(scopes[i]!.slug) : i) * STRIDE);
  }
  return bases;
}

/**
 * The local-markdown Tracker Adapter — reads tickets in the **mattpocock**
 * format (`/to-tickets`, `/to-spec`): one `<NN>-<slug>.md` file per ticket, no
 * frontmatter, prose fields the skills write.
 *
 * ```markdown
 * # 03 — Ticket title
 *
 * **What to build:** the end-to-end behaviour, from the user's perspective.
 *
 * **Blocked by:** 01, 02   (or "None — can start immediately")
 *
 * **Status:** ready-for-agent
 *
 * - [ ] Acceptance criterion
 * ```
 *
 * - **Ids come from the filename prefix** (`03-foo.md` → 3); files with no
 *   leading integer aren't tickets and are skipped. Numbers are ticket-local, so
 *   the `**Blocked by:** 01, 02` prose resolves directly against them.
 * - **Layout.** `Path:` names the ticket root (default `.scratch`). Tickets are
 *   read from `<root>/issues/`, else `<root>` directly, else every feature dir
 *   `<root>/<slug>/issues/`. Coexisting feature specs all show at once, each in
 *   its own id namespace (see {@link STRIDE}) — no `Path:` needed. Each feature's
 *   sibling `spec.md` is surfaced as a wayfinder **Map** (`isMap`); that feature's
 *   issues `parent` onto it, so the board rolls each spec's tickets up under it.
 * - **Writes.** The format carries no assignee, so `claim`/`release` remain
 *   local-only. `close` and `reopen` update the ticket's `**Status:**` field,
 *   which keeps lifecycle transitions portable with GitHub and GitLab.
 */
export function localMarkdownAdapter(
  dir: string,
  opts: { featureIndex?: FeatureIndex } = {},
): WritableTrackerAdapter {
  return {
    name: 'local-markdown',

    async scan() {
      return synthesise(await parseAll(dir, opts.featureIndex));
    },

    async readTicket(ref: TicketRef) {
      const found = (await synthesise(await parseAll(dir, opts.featureIndex))).find((t) => t.number === ref.number);
      if (!found) throw new Error(`local-markdown: no ticket #${ref.number} under ${dir}`);
      return found;
    },

    // The format has no assignee field. Harmonic still tracks reservations in
    // its own DB, while lifecycle changes persist through Status.
    async claim() {},
    async release() {},
    async close(ticket) {
      await writeStatus(dir, ticket.number, 'closed', opts.featureIndex);
    },
    async reopen(ticket) {
      // Reopening changes lifecycle only. `open` deliberately does not opt the
      // ticket back into AFK work: a human must explicitly restore
      // `ready-for-agent` when they want Harmonic to pick it again.
      await writeStatus(dir, ticket.number, 'open', opts.featureIndex);
    },

  };
}

/** Persist one lifecycle state through the adapter-owned Status field. */
async function writeStatus(root: string, ticketNumber: number, status: string, featureIndex?: FeatureIndex): Promise<void> {
  const ticket = (await parseAll(root, featureIndex)).find((parsed) => parsed.id === ticketNumber && !parsed.isMap);
  if (!ticket) throw new Error(`local-markdown: no ticket #${ticketNumber} under ${root}`);
  const raw = await readFile(ticket.path, 'utf8');
  const field = `**Status:** ${status}`;
  const updated = STATUS_FIELD.test(raw)
    ? raw.replace(STATUS_FIELD, field)
    : `${raw}${raw.endsWith('\n') ? '\n' : '\n\n'}${field}\n`;
  await writeFile(ticket.path, updated, 'utf8');
}

const idOf = (name: string): number => parseInt(name, 10);

/** `03-apps-workloads.md` → "apps workloads" — the title fallback when a file has no `# NN — …` heading. */
const slugTitle = (path: string): string =>
  basename(path, '.md')
    .replace(/^\d+[-_.]?/, '')
    .replace(/[-_]/g, ' ')
    .trim();

/** The `.md` files under `d` whose name starts with an integer, or `[]` if `d` isn't readable. */
async function ticketNames(d: string): Promise<string[]> {
  try {
    return (await readdir(d)).filter((n) => n.endsWith('.md') && /^\d+/.test(n));
  } catch {
    return [];
  }
}

/** One feature's dirs: where its `issues/` live and where its `spec.md` sits (its parent). `slug` (the feature dir name; empty for the single-feature layout) seeds its stable id base. */
interface Scope {
  slug: string;
  issuesDir: string;
  specDir: string;
}

/**
 * The feature scopes under `root` — see the layout note on {@link localMarkdownAdapter}.
 * A repo can hold several feature specs at once (`.scratch/<slug-a>/`,
 * `.scratch/<slug-b>/`); each becomes its own scope so the board shows every
 * spec's Map with its tickets, no `Path:` needed. Deterministic order (sorted).
 */
async function resolveScopes(root: string): Promise<Scope[]> {
  const nested = join(root, 'issues');
  if ((await ticketNames(nested)).length) return [{ slug: '', issuesDir: nested, specDir: root }];
  if ((await ticketNames(root)).length) return [{ slug: '', issuesDir: root, specDir: root }];

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return []; // missing root → empty scan
  }
  const scopes: Scope[] = [];
  for (const e of entries.sort()) {
    const cand = join(root, e, 'issues');
    if ((await ticketNames(cand)).length) scopes.push({ slug: e, issuesDir: cand, specDir: join(root, e) });
  }
  return scopes;
}

interface Parsed {
  id: number;
  path: string;
  title: string;
  state: TicketState;
  labels: string[];
  body: string;
  blockedBy: number[];
  parent: number | null;
  isMap: boolean;
  createdAt: string;
  closedAt: string | null;
}

async function parseAll(root: string, featureIndex?: FeatureIndex): Promise<Parsed[]> {
  const scopes = await resolveScopes(root);
  const bases = await assignBases(scopes, featureIndex);
  const perScope = await Promise.all(scopes.map((scope, i) => parseScope(scope, bases[i]!)));
  return perScope.flat();
}

/** Parse one feature scope, offsetting every local id by `base` so it stays unique across features. */
async function parseScope({ issuesDir, specDir }: Scope, base: number): Promise<Parsed[]> {
  const spec = await parseSpec(join(specDir, 'spec.md'), base);
  const parent = spec ? spec.id : null;

  const names = await ticketNames(issuesDir);
  const issues = await Promise.all(
    names.map(async (name) => {
      const path = join(issuesDir, name);
      const [raw, mtime] = await Promise.all([
        readFile(path, 'utf8'),
        stat(path).then((s) => s.mtime.toISOString()),
      ]);
      return parse(raw, base + idOf(name), path, mtime, parent, base);
    }),
  );
  return spec ? [spec, ...issues] : issues;
}

/** The heading text of `# …`, with an optional `NN —` prefix stripped; slug fallback. */
function headingTitle(raw: string, path: string): { heading: string; title: string } {
  const heading = raw.split('\n').find((l) => /^#\s+/.test(l)) ?? '';
  const title = heading.match(/^#\s+(?:\d+\s*[—–-]\s*)?(.+?)\s*$/)?.[1]?.trim() || slugTitle(path);
  return { heading, title };
}

const stripHeading = (raw: string, heading: string): string =>
  (heading ? raw.slice(raw.indexOf(heading) + heading.length) : raw).trim();

/** `**Status:**` / `**Blocked by:**` are the skills' literal field markers; a body reusing them mis-parses. Adapter-owned format, so we control it. */
function parse(raw: string, id: number, path: string, mtime: string, parent: number | null, base: number): Parsed {
  const { heading, title } = headingTitle(raw, path);

  const status = raw.match(/^\s*\*\*Status:\*\*\s*(.+?)\s*$/im)?.[1]?.trim() ?? '';
  // Closed-state precedence, explicit Status authoritative over the heuristic:
  //   1. an explicit done-ish `**Status:**` (done/closed/…) → closed;
  //   2. else an explicit open `**Status:**` (open/reopened) → open, even when
  //      every box is ticked — so `reopen` (which writes `**Status:** open`) is
  //      not silently overridden by ticked acceptance boxes (#237);
  //   3. else the fallback heuristic: every acceptance checkbox ticked → closed.
  // A ticket with a neutral/absent Status (e.g. `ready-for-agent`) rests entirely
  // on its boxes; no boxes + neutral Status → open.
  const boxes = [...raw.matchAll(/^[ \t]*[-*]\s+\[([ xX])\]/gm)];
  const allChecked = boxes.length > 0 && boxes.every((m) => m[1] !== ' ');
  const state: TicketState = CLOSED_STATUS.test(status)
    ? 'closed'
    : OPEN_STATUS.test(status)
      ? 'open'
      : allChecked
        ? 'closed'
        : 'open';

  // "Blocked by" ids are feature-local; offset them into this feature's namespace.
  const blockedLine = raw.match(/^\s*\*\*Blocked by:\*\*\s*(.+?)\s*$/im)?.[1] ?? '';
  const blockedBy = /\bnone\b/i.test(blockedLine)
    ? []
    : [...blockedLine.matchAll(/\d+/g)].map((m) => base + parseInt(m[0]!, 10));

  return {
    id,
    path,
    title,
    state,
    labels: status ? [status] : [],
    body: stripHeading(raw, heading),
    blockedBy,
    parent,
    isMap: false,
    createdAt: mtime,
    closedAt: state === 'closed' ? mtime : null,
  };
}

/** The feature's `spec.md`, surfaced as its wayfinder Map (local id {@link SPEC_ID}, offset by `base`). Null if there is no spec. */
async function parseSpec(path: string, base: number): Promise<Parsed | null> {
  let raw: string;
  let mtime: string;
  try {
    raw = await readFile(path, 'utf8');
    mtime = (await stat(path)).mtime.toISOString();
  } catch {
    return null;
  }
  const { heading, title } = headingTitle(raw, path);
  return {
    id: base + SPEC_ID,
    path,
    title: title.replace(/^spec:\s*/i, ''),
    state: 'open',
    labels: [],
    body: stripHeading(raw, heading),
    blockedBy: [],
    parent: null,
    isMap: true,
    createdAt: mtime,
    closedAt: null,
  };
}

function synthesise(files: Parsed[]): Ticket[] {
  const byId = new Map(files.map((f) => [f.id, f]));
  const ref = (id: number): TicketRef | null => {
    const f = byId.get(id);
    return f ? { number: f.id, title: f.title, state: f.state } : null;
  };
  // A declared blockedBy implies the target blocks us; dangling refs are dropped.
  const blockedBy = new Map<number, Set<number>>(
    files.map((f) => [f.id, new Set(f.blockedBy.filter((b) => byId.has(b)))]),
  );
  const blocking = new Map<number, Set<number>>(files.map((f) => [f.id, new Set<number>()]));
  for (const f of files) for (const b of f.blockedBy) blocking.get(b)?.add(f.id);
  const refs = (ids: Set<number>): TicketRef[] => [...ids].map(ref).filter((r): r is TicketRef => r !== null);

  return files.map((f) => ({
    number: f.id,
    title: f.title,
    state: f.state,
    body: f.body,
    createdAt: f.createdAt,
    closedAt: f.closedAt,
    labels: f.labels,
    assignees: [],
    parent: f.parent !== null && byId.has(f.parent) ? f.parent : null,
    blockedBy: refs(blockedBy.get(f.id)!),
    blocking: refs(blocking.get(f.id)!),
    comments: [],
    isMap: f.isMap,
    url: pathToFileURL(f.path).href,
  }));
}
