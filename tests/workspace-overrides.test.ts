import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../src/db/index.js';
import { WorkspaceService } from '../src/domain/workspaces.js';
import { verificationCommandSchema, budgetGuardrailSchema } from '../src/config.js';

/**
 * Per-workspace setting overrides on the Workspace API (ADR-0012, issue #64).
 * The data model (#59) added the nullable columns; here the service persists
 * and clears them. `null` means *inherit*, an explicit value overrides, and an
 * omitted (`undefined`) field is left untouched — the three states the settings
 * page needs to round-trip through PATCH.
 */
describe('WorkspaceService override persistence (issue #64)', () => {
  let dataDir: string;
  let db: Db;
  let workspaces: WorkspaceService;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'harmonic-ws-over-'));
    db = openDb(dataDir); // backfills the single Default Workspace
    workspaces = new WorkspaceService(db);
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a fresh Workspace inherits every overridable setting (all null)', () => {
    const ws = workspaces.list()[0]!;
    expect(ws.harness).toBeNull();
    expect(ws.model).toBeNull();
    expect(ws.chatHarness).toBeNull();
    expect(ws.chatModel).toBeNull();
    expect(ws.isolationMode).toBeNull();
    expect(ws.priority).toBeNull();
    expect(ws.maxConcurrentRuns).toBeNull();
    expect(ws.autoRunnerEnabled).toBeNull();
    expect(ws.verificationCommand).toBeNull();
    expect(ws.verificationCritic).toBeNull();
    expect(ws.guardrailBudget).toBeNull();
    expect(ws.guardrailProgress).toBeNull();
  });

  it('sets explicit overrides', () => {
    const ws = workspaces.list()[0]!;
    const updated = workspaces.update(ws.id, {
      harness: 'codex',
      model: 'gpt-5',
      chatHarness: 'claude',
      chatModel: 'claude-opus-5',
      isolationMode: 'worktree',
      priority: 'high',
      maxConcurrentRuns: 2,
      autoRunnerEnabled: true,
    });
    expect(updated.harness).toBe('codex');
    expect(updated.model).toBe('gpt-5');
    expect(updated.chatHarness).toBe('claude');
    expect(updated.chatModel).toBe('claude-opus-5');
    expect(updated.isolationMode).toBe('worktree');
    expect(updated.priority).toBe('high');
    expect(updated.maxConcurrentRuns).toBe(2);
    expect(updated.autoRunnerEnabled).toBe(true);
  });

  it('overrides the chat default independently of the Task default', () => {
    const ws = workspaces.list()[0]!;
    // Chat and Tasks are separate columns: pointing chat at a different agent
    // leaves the Task default untouched.
    const updated = workspaces.update(ws.id, { harness: 'codex', chatHarness: 'claude', chatModel: 'claude-opus-5' });
    expect(updated.harness).toBe('codex'); // Task default
    expect(updated.chatHarness).toBe('claude'); // chat default, independent
    expect(updated.chatModel).toBe('claude-opus-5');
    expect(updated.model).toBeNull(); // Task model still inherits
  });

  it('clears an override back to inherit with null', () => {
    const ws = workspaces.list()[0]!;
    workspaces.update(ws.id, { harness: 'codex', chatHarness: 'claude', maxConcurrentRuns: 2, autoRunnerEnabled: false });
    const cleared = workspaces.update(ws.id, {
      harness: null,
      chatHarness: null,
      maxConcurrentRuns: null,
      autoRunnerEnabled: null,
    });
    expect(cleared.harness).toBeNull();
    expect(cleared.chatHarness).toBeNull();
    expect(cleared.maxConcurrentRuns).toBeNull();
    expect(cleared.autoRunnerEnabled).toBeNull();
  });

  it('leaves an omitted override untouched (only patches what is sent)', () => {
    const ws = workspaces.list()[0]!;
    workspaces.update(ws.id, { harness: 'codex', priority: 'low' });
    const renamed = workspaces.update(ws.id, { name: 'Renamed' });
    expect(renamed.name).toBe('Renamed');
    expect(renamed.harness).toBe('codex'); // untouched
    expect(renamed.priority).toBe('low'); // untouched
  });

  it('keeps a false autoRunnerEnabled override distinct from inherit (null)', () => {
    const ws = workspaces.list()[0]!;
    const off = workspaces.update(ws.id, { autoRunnerEnabled: false });
    expect(off.autoRunnerEnabled).toBe(false); // an explicit "off", not inherit
    const untouched = workspaces.update(ws.id, { name: ws.name });
    expect(untouched.autoRunnerEnabled).toBe(false);
  });

  it('sets explicit verifier overrides, stored as JSON (issue #132)', () => {
    const ws = workspaces.list()[0]!;
    // .parse fills in the schema's own defaults (env: {}, timeoutSeconds: 600) —
    // the same shape the PATCH route hands the service after body validation.
    const updated = workspaces.update(ws.id, {
      verificationCommand: verificationCommandSchema.parse({ command: 'npm', args: ['test'] }),
      verificationCritic: { prompt: 'review', model: 'claude-opus-5' },
    });
    // The stored JSON is a superset of what was sent — toMatchObject, not toEqual.
    expect(JSON.parse(updated.verificationCommand!)).toMatchObject({ command: 'npm', args: ['test'] });
    expect(JSON.parse(updated.verificationCritic!)).toMatchObject({ prompt: 'review', model: 'claude-opus-5' });
  });

  it('clears verifier overrides back to inherit with null (issue #132)', () => {
    const ws = workspaces.list()[0]!;
    workspaces.update(ws.id, {
      verificationCommand: verificationCommandSchema.parse({ command: 'npm', args: ['test'] }),
      verificationCritic: { prompt: 'review', model: 'claude-opus-5' },
    });
    const cleared = workspaces.update(ws.id, { verificationCommand: null, verificationCritic: null });
    expect(cleared.verificationCommand).toBeNull();
    expect(cleared.verificationCritic).toBeNull();
  });

  it('leaves an omitted verifier override untouched (issue #132)', () => {
    const ws = workspaces.list()[0]!;
    workspaces.update(ws.id, { verificationCommand: verificationCommandSchema.parse({ command: 'npm', args: ['test'] }) });
    const renamed = workspaces.update(ws.id, { name: 'Renamed' });
    expect(renamed.name).toBe('Renamed');
    expect(JSON.parse(renamed.verificationCommand!)).toMatchObject({ command: 'npm', args: ['test'] }); // untouched
  });

  it('sets explicit guardrail overrides (issue #126)', () => {
    const ws = workspaces.list()[0]!;
    const updated = workspaces.update(ws.id, {
      guardrailBudget: budgetGuardrailSchema.parse({ wallClockMinutes: 120 }),
      guardrailProgress: true,
    });
    // The stored JSON is a superset of what was sent (schema defaults filled in) — toMatchObject, not toEqual.
    expect(JSON.parse(updated.guardrailBudget!)).toMatchObject({ wallClockMinutes: 120 });
    expect(updated.guardrailProgress).toBe(true);
  });

  it('clears guardrail overrides back to inherit with null (issue #126)', () => {
    const ws = workspaces.list()[0]!;
    workspaces.update(ws.id, {
      guardrailBudget: budgetGuardrailSchema.parse({ wallClockMinutes: 120 }),
      guardrailProgress: true,
    });
    const cleared = workspaces.update(ws.id, { guardrailBudget: null, guardrailProgress: null });
    expect(cleared.guardrailBudget).toBeNull();
    expect(cleared.guardrailProgress).toBeNull();
  });

  it('keeps a false guardrailProgress override distinct from inherit (null) (issue #126)', () => {
    const ws = workspaces.list()[0]!;
    const off = workspaces.update(ws.id, { guardrailProgress: false });
    expect(off.guardrailProgress).toBe(false); // an explicit "off", not inherit
    const untouched = workspaces.update(ws.id, { name: ws.name });
    expect(untouched.guardrailProgress).toBe(false);
  });
});
