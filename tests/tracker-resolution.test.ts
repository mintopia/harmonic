import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTrackerAdapter, resolutionSuccess } from '../src/tracker/adapter.js';
import { selectTracker } from '../src/tracker/select.js';
import { configuredTrackerSchema } from '../src/tracker/configured.js';
import { detectRepository, forgejoVersionProbe, remoteHost } from '../src/repository/detect.js';
import { DEFAULT_TRIAGE_LABELS, parseTriageLabelsDoc, resolveTriageLabels } from '../src/tracker/triage-labels.js';

const roots: string[] = [];
const mkRepo = (declaration?: string, triage?: string) => {
  const root = mkdtempSync(join(tmpdir(), 'harmonic-resolution-'));
  roots.push(root);
  mkdirSync(join(root, 'docs/agents'), { recursive: true });
  if (declaration !== undefined) writeFileSync(join(root, 'docs/agents/issue-tracker.md'), declaration);
  if (triage !== undefined) writeFileSync(join(root, 'docs/agents/triage-labels.md'), triage);
  return root;
};
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('selectTracker precedence', () => {
  it('Configured Tracker beats everything', () => {
    expect(selectTracker({ configured: { kind: 'gitlab' }, detectedName: 'GitHub', codeRepository: 'github' })).toEqual({ kindId: 'gitlab', source: 'configured' });
  });
  it('Detected Tracker beats the Code Repository', () => {
    expect(selectTracker({ detectedName: 'Local Markdown', codeRepository: 'github' })).toEqual({ kindId: 'local-markdown', source: 'detected' });
  });
  it('falls back to the Code Repository when it is a tracker kind', () => {
    expect(selectTracker({ codeRepository: 'gitlab' })).toEqual({ kindId: 'gitlab', source: 'code-repository' });
  });
  it('is none when nothing is configured, detected, or inferable', () => {
    expect(selectTracker({})).toBeNull();
    expect(selectTracker({ detectedName: 'Linear', codeRepository: 'forgejo' })).toBeNull();
  });
});

describe('resolveTrackerAdapter end to end', () => {
  it('configured wins over a conflicting declaration', async () => {
    const root = mkRepo('# Issue tracker: GitHub\n');
    const adapter = await resolveTrackerAdapter(root, undefined, { configured: { kind: 'gitlab', settings: { project: 'g/r' } } });
    expect(resolutionSuccess(adapter)).toMatchObject({ name: 'gitlab', source: 'configured' });
  });
  it('detected is used without a Configured Tracker', async () => {
    const root = mkRepo('# Issue tracker: GitHub\n');
    expect(resolutionSuccess(await resolveTrackerAdapter(root))).toMatchObject({ name: 'github', source: 'detected' });
  });
  it('the Code Repository is used when there is no declaration', async () => {
    const root = mkRepo();
    const adapter = await resolveTrackerAdapter(root, undefined, { codeRepository: 'github' });
    expect(resolutionSuccess(adapter)).toMatchObject({ name: 'github', source: 'code-repository' });
  });
  it('fails with no-declaration when nothing resolves', async () => {
    await expect(resolveTrackerAdapter(mkRepo())).rejects.toMatchObject({ code: 'no-declaration' });
  });
  it('an unknown declaration name still reports unsupported', async () => {
    await expect(resolveTrackerAdapter(mkRepo('# Issue tracker: Linear\n'))).rejects.toMatchObject({ code: 'unsupported' });
  });
  it('a misconfigured Configured Tracker reports misconfigured', async () => {
    await expect(resolveTrackerAdapter(mkRepo(), undefined, { configured: { kind: 'gitlab' } })).rejects.toMatchObject({ code: 'misconfigured' });
  });
});

describe('configuredTrackerSchema', () => {
  it('validates kind and per-kind settings', () => {
    expect(configuredTrackerSchema.safeParse({ kind: 'gitlab', settings: { project: 'g/r' } }).success).toBe(true);
    expect(configuredTrackerSchema.safeParse({ kind: 'nope' }).success).toBe(false);
    expect(configuredTrackerSchema.safeParse({ kind: 'gitlab', settings: { bogus: 1 } }).success).toBe(false);
  });
});

describe('detectRepository', () => {
  const never = async () => { throw new Error('probe must not run'); };
  it('maps github.com and gitlab.com without probing, in every remote syntax', async () => {
    expect(await detectRepository('git@github.com:o/r.git', never)).toBe('github');
    expect(await detectRepository('https://github.com/o/r', never)).toBe('github');
    expect(await detectRepository('ssh://git@gitlab.com/g/r.git', never)).toBe('gitlab');
  });
  it('treats another host as Forgejo only when the probe answers', async () => {
    const seen: string[] = [];
    expect(await detectRepository('https://code.example.org/o/r.git', async (h) => { seen.push(h); return true; })).toBe('forgejo');
    expect(seen).toEqual(['code.example.org']);
    expect(await detectRepository('git@git.example.org:o/r.git', async () => false)).toBeNull();
  });
  it('returns null for an unparseable remote', async () => {
    expect(await detectRepository('', never)).toBeNull();
  });
  it('parses hosts', () => {
    expect(remoteHost('git@Git.Example.org:o/r')).toBe('git.example.org');
    expect(remoteHost('https://user:pw@host.test:8443/o/r')).toBe('host.test');
  });
  it('forgejoVersionProbe accepts a JSON version and rejects errors', async () => {
    const ok = forgejoVersionProbe((async () => new Response(JSON.stringify({ version: '9.0.0' }))) as typeof fetch);
    const notFound = forgejoVersionProbe((async () => new Response('', { status: 404 })) as typeof fetch);
    const down = forgejoVersionProbe((async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch);
    expect(await ok('h')).toBe(true);
    expect(await notFound('h')).toBe(false);
    expect(await down('h')).toBe(false);
  });
});

describe('Triage Labels', () => {
  const doc = [
    '| Label in mattpocock/skills | Label in our tracker | Meaning |',
    '| --- | --- | --- |',
    '| `needs-triage` | `triage` | x |',
    '| `ready-for-agent` | `agent:ready` | x |',
    '| `ready-for-human` | `human` | x |',
  ].join('\n');
  it('parses the role table, ignoring unknown roles', () => {
    expect(parseTriageLabelsDoc(doc)).toEqual({ readyForAgent: 'agent:ready', readyForHuman: 'human' });
  });
  it('resolves per role: Workspace, then repo, then default', () => {
    const { labels, sources } = resolveTriageLabels({ readyForAgent: 'ws-ready' }, doc);
    expect(labels).toEqual({ readyForAgent: 'ws-ready', readyForHuman: 'human', epic: 'epic', wayfinderMap: 'wayfinder:map' });
    expect(sources).toEqual({ readyForAgent: 'workspace', readyForHuman: 'repo', epic: 'default', wayfinderMap: 'default' });
  });
  it('is all defaults with no setting and no doc', () => {
    expect(resolveTriageLabels(null, null).labels).toEqual(DEFAULT_TRIAGE_LABELS);
  });
});
