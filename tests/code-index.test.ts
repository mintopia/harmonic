import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codeIndexRepoGuidance } from '../src/execution/prompt-template.js';
import {
  codeIndexAvailable,
  dropIndex,
  dropIndexForPath,
  indexWorktree,
  resetCodeIndexAvailabilityForTest,
} from '../src/execution/code-index.js';

// A fake jCodeMunch CLI that appends each invocation's subcommand to FAKE_CLI_LOG
// and returns a single repo whose source_root is FAKE_CLI_ROOT, so repoIdForPath
// resolves it. Lets a test assert the ORDER of subcommands indexWorktree issues.
const FAKE_CLI = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_CLI_LOG) fs.appendFileSync(process.env.FAKE_CLI_LOG, args[0] + '\\n');
if (args[0] === 'list-repos') {
  process.stdout.write(JSON.stringify({ repos: [{ repo_id: 'local/fake-1', source_root: process.env.FAKE_CLI_ROOT }] }));
}
process.exit(0);
`;

describe('codeIndexRepoGuidance (pure prompt fragment)', () => {
  it('renders nothing for an empty repo id', () => {
    expect(codeIndexRepoGuidance('')).toBe('');
  });

  it('names the repo id and forbids resolving the repo by `.`', () => {
    const block = codeIndexRepoGuidance('local/run-7-abc123');
    expect(block).toContain('local/run-7-abc123');
    expect(block).toMatch(/do not resolve the repo by `\.`/i);
    expect(block).toMatch(/stale code/i);
  });
});

describe('code-index CLI wrapper (best-effort — a missing CLI degrades to a skip)', () => {
  const prev = process.env.HARMONIC_CODE_INDEX_CLI;
  let cleanup: (() => void) | null = null;
  afterEach(() => {
    if (prev === undefined) delete process.env.HARMONIC_CODE_INDEX_CLI;
    else process.env.HARMONIC_CODE_INDEX_CLI = prev;
    delete process.env.FAKE_CLI_LOG;
    delete process.env.FAKE_CLI_ROOT;
    resetCodeIndexAvailabilityForTest();
    cleanup?.();
    cleanup = null;
  });

  it('reports unavailable and never throws when the CLI is absent', async () => {
    process.env.HARMONIC_CODE_INDEX_CLI = 'harmonic-no-such-code-index-cli';
    resetCodeIndexAvailabilityForTest();
    expect(await codeIndexAvailable()).toBe(false);
    expect(await indexWorktree('/tmp/whatever')).toBeNull();
    // Reaping must be a silent no-op, not a rejection, so teardown never wedges.
    await expect(dropIndex('local/x-1')).resolves.toBeUndefined();
    await expect(dropIndexForPath('/tmp/whatever')).resolves.toBeUndefined();
  });

  // Regression guard for Task 343: a critic worktree path (`critic-<attemptId>`) is
  // reused across a Run's reviews, so indexWorktree must invalidate the path's
  // cached index before re-indexing — otherwise the second review reads the first
  // review's stale tree and fails work that is present.
  it('drops the path index before re-indexing so a reused worktree path cannot serve a stale tree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-idx-'));
    cleanup = () => rmSync(dir, { recursive: true, force: true });
    const cliPath = join(dir, 'fake-cli.cjs');
    writeFileSync(cliPath, FAKE_CLI);
    chmodSync(cliPath, 0o755);
    process.env.HARMONIC_CODE_INDEX_CLI = cliPath;
    process.env.FAKE_CLI_LOG = join(dir, 'calls.log');
    process.env.FAKE_CLI_ROOT = dir;
    resetCodeIndexAvailabilityForTest();

    const id = await indexWorktree(dir);
    expect(id).toBe('local/fake-1');

    const calls = readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');
    const dropAt = calls.indexOf('delete-index');
    const indexAt = calls.indexOf('index');
    expect(dropAt).toBeGreaterThanOrEqual(0); // the stale index was dropped
    expect(indexAt).toBeGreaterThan(dropAt); // ...before the fresh parse
  });
});
