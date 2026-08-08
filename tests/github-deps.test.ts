import { describe, it, expect } from 'vitest';
import { githubAdapter } from '../src/tracker/github.js';

/** Minimal RawIssue; only the fields `normalise` reads matter here. */
const raw = (over: Record<string, unknown>) => ({
  number: 0,
  title: 't',
  state: 'OPEN',
  body: '',
  createdAt: '',
  closedAt: null,
  labels: [],
  assignees: [],
  comments: [],
  parent: null,
  blockedBy: null,
  blocking: null,
  url: '',
  ...over,
});

const scanning = (issues: unknown[]) => githubAdapter('/repo', async () => JSON.stringify(issues));

describe('GitHub adapter — body-line dependency fallback (issue #46 regression)', () => {
  it('parses "Depends on: T1 (#47)" into blockedBy, ignoring a "Part of #46" prefix', async () => {
    const [t] = await scanning([raw({ number: 48, body: 'Part of #46. Depends on: T1 (#47). Ref: ADR 0009.' })]).scan();
    expect(t!.blockedBy.map((b) => b.number)).toEqual([47]);
  });

  it('parses a "Blocked by: #47, #49" line into multiple edges', async () => {
    const [t] = await scanning([raw({ number: 50, body: 'Blocked by: #47, #49' })]).scan();
    expect(t!.blockedBy.map((b) => b.number).sort((a, b) => a - b)).toEqual([47, 49]);
  });

  it('merges native edges with body edges, dedupes, and excludes self-reference', async () => {
    const [t] = await scanning([
      raw({
        number: 50,
        body: 'Depends on #50 and #47',
        blockedBy: { nodes: [{ number: 47, title: 'x', state: 'OPEN' }, { number: 48, title: 'y', state: 'OPEN' }] },
      }),
    ]).scan();
    expect(t!.blockedBy.map((b) => b.number).sort((a, b) => a - b)).toEqual([47, 48]);
  });

  it('a line with no dependency keyword yields no edges', async () => {
    const [t] = await scanning([raw({ number: 47, body: 'Part of #46. Depends on: none.' })]).scan();
    expect(t!.blockedBy).toEqual([]);
  });
});
