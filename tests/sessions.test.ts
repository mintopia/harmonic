import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAsyncDb, type AsyncDbHandle } from '../src/db/async.js';
import { sessions } from '../src/db/schema.js';
import { DomainError } from '../src/domain/errors.js';
import { isUniqueViolation } from '../src/domain/work-context-leases.js';
import {
  SessionStore,
  stripMcpCredentials,
  readLoadSessionCapability,
  estimateWarmUntil,
  type DispatchSessionInput,
} from '../src/domain/sessions.js';
import { allWorkspaces } from './helpers.js';

/**
 * The durable Session store and its pure helpers (issue #141, reliability-design
 * Unit C), mirroring `tests/guardrail-events.test.ts`'s store-test template.
 */
describe('Sessions (issue #141)', () => {
  describe('stripMcpCredentials', () => {
    it('strips headers from a realistic credentialed mcpServers list, leaking the secret nowhere', () => {
      const servers = [
        {
          name: 'harmonic',
          type: 'http',
          url: 'http://x',
          headers: [{ name: 'Authorization', value: 'Bearer SECRET' }],
        },
      ];
      const result = stripMcpCredentials(servers);
      expect(result).toEqual([{ name: 'harmonic', type: 'http', url: 'http://x' }]);
      expect((result[0] as Record<string, unknown>).headers).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('SECRET');
    });

    it('strips env, token, authorization (any case), nested, at any depth', () => {
      const servers = [
        {
          name: 'stdio-server',
          env: { API_KEY: 'x' },
          token: 'tok-value',
          Authorization: 'Bearer y',
          nested: {
            deeper: {
              env: { API_KEY: 'x' },
              AUTHORIZATION: 'z',
            },
          },
        },
      ];
      const [result] = stripMcpCredentials(servers) as Record<string, unknown>[];
      expect(result).toBeDefined();
      expect(JSON.stringify(result)).not.toContain('API_KEY');
      expect(result!).not.toHaveProperty('env');
      expect(result!).not.toHaveProperty('token');
      expect(result!).not.toHaveProperty('Authorization');
      expect((result!.nested as Record<string, unknown>).deeper).not.toHaveProperty('env');
      expect((result!.nested as Record<string, unknown>).deeper).not.toHaveProperty('AUTHORIZATION');
      expect(result!.name).toBe('stdio-server');
    });

    it('returns [] for non-array input: undefined, {}, null', () => {
      expect(stripMcpCredentials(undefined)).toEqual([]);
      expect(stripMcpCredentials({})).toEqual([]);
      expect(stripMcpCredentials(null)).toEqual([]);
    });

    it('preserves non-secret fields', () => {
      const [result] = stripMcpCredentials([{ name: 'harmonic', type: 'http', url: 'http://x' }]) as Record<
        string,
        unknown
      >[];
      expect(result).toEqual({ name: 'harmonic', type: 'http', url: 'http://x' });
    });
  });

  describe('readLoadSessionCapability', () => {
    it('true when agentCapabilities.loadSession === true', () => {
      expect(readLoadSessionCapability({ agentCapabilities: { loadSession: true } })).toBe(true);
    });

    it('false when result is undefined', () => {
      expect(readLoadSessionCapability(undefined)).toBe(false);
    });

    it('false when agentCapabilities is missing', () => {
      expect(readLoadSessionCapability({})).toBe(false);
    });

    it('false when loadSession is false', () => {
      expect(readLoadSessionCapability({ agentCapabilities: { loadSession: false } })).toBe(false);
    });

    it('false when loadSession is a non-boolean truthy value', () => {
      expect(readLoadSessionCapability({ agentCapabilities: { loadSession: 'yes' as unknown as boolean } })).toBe(
        false,
      );
    });
  });

  describe('estimateWarmUntil', () => {
    it("claude's warm window is now + 1h", () => {
      expect(estimateWarmUntil('claude', 1000)).toBe(1000 + 3_600_000);
    });

    it('codex has no known warm window: null', () => {
      expect(estimateWarmUntil('codex', 1000)).toBeNull();
    });

    it('an unknown harness: null', () => {
      expect(estimateWarmUntil('some-future-harness', 1000)).toBeNull();
    });
  });

  describe('SessionStore', () => {
    let dir: string;
    let asyncDb: AsyncDbHandle;
    let store: SessionStore;
    let workspaceId: number;
    const now = 1_000_000;

    const baseInput = (overrides: Partial<DispatchSessionInput> = {}): DispatchSessionInput => ({
      harness: 'claude',
      harnessSessionId: 'sess-1',
      model: 'claude-model',
      cwd: '/tmp/work',
      workspaceId,
      mcpTemplates: [],
      capabilities: undefined,
      adapterVersion: 'claude@1',
      now,
      ...overrides,
    });

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), 'harmonic-sessions-'));
      asyncDb = await openAsyncDb(dir);
      store = new SessionStore(asyncDb);
      workspaceId = (await allWorkspaces(asyncDb)())[0]!.id;
    });
    afterEach(async () => {
      await asyncDb.close();
      rmSync(dir, { recursive: true, force: true });
    });

    describe('recordDispatch — insert path', () => {
      it('inserts a fresh row with the dispatched fields and active status', async () => {
        const row = await store.recordDispatch(baseInput());
        expect(row).toMatchObject({
          status: 'active',
          harness: 'claude',
          harnessSessionId: 'sess-1',
          model: 'claude-model',
          cwd: '/tmp/work',
          transcriptPath: null,
          lastActiveAt: now,
          createdAt: now,
          updatedAt: now,
          adapterVersion: 'claude@1',
        });
        expect(row.id).toBeTypeOf('number');
      });

      it('mines supportsLoadSession and snapshots capabilities when loadSession: true', async () => {
        const row = await store.recordDispatch(
          baseInput({ capabilities: { agentCapabilities: { loadSession: true } } }),
        );
        expect(row.supportsLoadSession).toBe(true);
        expect(JSON.parse(row.capabilitySnapshot)).toEqual({ agentCapabilities: { loadSession: true } });
      });

      it('capabilities: undefined yields capabilitySnapshot "{}" and supportsLoadSession false', async () => {
        const row = await store.recordDispatch(baseInput({ capabilities: undefined }));
        expect(row.capabilitySnapshot).toBe('{}');
        expect(row.supportsLoadSession).toBe(false);
      });

      it('mcpTemplates: strips credentials before persisting', async () => {
        const row = await store.recordDispatch(
          baseInput({
            mcpTemplates: [
              {
                name: 'harmonic',
                type: 'http',
                url: 'http://x',
                headers: [{ name: 'Authorization', value: 'Bearer SECRET' }],
              },
            ],
          }),
        );
        expect(row.mcpTemplates).not.toContain('SECRET');
        expect(JSON.parse(row.mcpTemplates)).toEqual([{ name: 'harmonic', type: 'http', url: 'http://x' }]);
      });

      it("estimatedWarmUntil: now + 1h for claude, null for codex", async () => {
        const claudeRow = await store.recordDispatch(
          baseInput({ harness: 'claude', harnessSessionId: 'sess-claude' }),
        );
        expect(claudeRow.estimatedWarmUntil).toBe(now + 3_600_000);

        const codexRow = await store.recordDispatch(baseInput({ harness: 'codex', harnessSessionId: 'sess-codex' }));
        expect(codexRow.estimatedWarmUntil).toBeNull();
      });

      it('permissionMode: null when omitted, echoed when passed', async () => {
        const withoutMode = await store.recordDispatch(baseInput({ harnessSessionId: 'sess-no-mode' }));
        expect(withoutMode.permissionMode).toBeNull();

        const withMode = await store.recordDispatch(
          baseInput({ harnessSessionId: 'sess-with-mode', permissionMode: 'auto' }),
        );
        expect(withMode.permissionMode).toBe('auto');
      });
    });

    describe('recordDispatch — upsert path', () => {
      it('a repeat dispatch on the same (harness, harnessSessionId) updates the existing row, not a new one', async () => {
        const first = await store.recordDispatch(baseInput({ model: 'model-a', transcriptPath: '/logs/first.jsonl' }));
        const later = now + 60_000;
        const second = await store.recordDispatch(baseInput({ model: 'model-b', transcriptPath: null, now: later }));

        expect(second.id).toBe(first.id);
        expect(second.model).toBe('model-b');
        expect(second.lastActiveAt).toBe(later);
        expect(second.updatedAt).toBe(later);
        expect(second.createdAt).toBe(first.createdAt);
        expect(second.transcriptPath).toBe('/logs/first.jsonl');
      });

      it('does not create a second row for the same key', async () => {
        await store.recordDispatch(baseInput({ model: 'model-a' }));
        await store.recordDispatch(baseInput({ model: 'model-b', now: now + 1000 }));

        const row = await store.getByHarnessSession('claude', 'sess-1');
        expect(row).toBeDefined();
        expect(row!.model).toBe('model-b');
      });

      it('a different harnessSessionId creates a distinct row', async () => {
        const first = await store.recordDispatch(baseInput({ harnessSessionId: 'sess-1' }));
        const second = await store.recordDispatch(baseInput({ harnessSessionId: 'sess-2' }));
        expect(second.id).not.toBe(first.id);
      });
    });

    describe('setPermissionMode', () => {
      it('updates the permission mode and updatedAt, returning the row', async () => {
        const created = await store.recordDispatch(baseInput());
        const updated = await store.setPermissionMode(created.id, 'bypassPermissions', now + 5000);
        expect(updated.permissionMode).toBe('bypassPermissions');
        expect(updated.updatedAt).toBe(now + 5000);
        expect(updated.id).toBe(created.id);
      });
    });

    describe('setTranscriptPath', () => {
      it('records a transcript discovered after the initial dispatch', async () => {
        const created = await store.recordDispatch(baseInput());
        const updated = await store.setTranscriptPath(created.id, '/logs/discovered.jsonl', now + 5000);
        expect(updated.transcriptPath).toBe('/logs/discovered.jsonl');
        expect(updated.updatedAt).toBe(now + 5000);
      });
    });

    describe('recordResumeIncompatibility (issue #145 AC5)', () => {
      it('a freshly-recorded Session has no resume incompatibility recorded', async () => {
        const created = await store.recordDispatch(baseInput());
        expect(created.resumeIncompatibilityReason).toBeNull();
        expect(created.resumeIncompatibilityDetail).toBeNull();
      });

      it('persists the reason and detail on the original Session, touching updatedAt', async () => {
        const created = await store.recordDispatch(baseInput());
        const later = now + 5000;
        const updated = await store.recordResumeIncompatibility(
          created.id,
          'adapter-version-mismatch',
          'stored adapter claude@1 != current claude@2',
          later,
        );
        expect(updated.resumeIncompatibilityReason).toBe('adapter-version-mismatch');
        expect(updated.resumeIncompatibilityDetail).toBe('stored adapter claude@1 != current claude@2');
        expect(updated.updatedAt).toBe(later);
        expect(updated.id).toBe(created.id);

        const reread = await store.get(created.id);
        expect(reread.resumeIncompatibilityReason).toBe('adapter-version-mismatch');
        expect(reread.resumeIncompatibilityDetail).toBe('stored adapter claude@1 != current claude@2');
        expect(reread.updatedAt).toBe(later);
      });
    });

    describe('get', () => {
      it('returns the row for a known id', async () => {
        const created = await store.recordDispatch(baseInput());
        expect(await store.get(created.id)).toEqual(created);
      });

      it('throws DomainError(not_found) for a missing id', async () => {
        await expect(store.get(999_999)).rejects.toThrow(DomainError);
        let caught: unknown;
        try {
          await store.get(999_999);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(DomainError);
        expect((caught as DomainError).code).toBe('not_found');
      });
    });

    describe('getByHarnessSession', () => {
      it('returns undefined for an unknown (harness, harnessSessionId)', async () => {
        expect(await store.getByHarnessSession('claude', 'nope')).toBeUndefined();
      });

      it('returns the row for a known (harness, harnessSessionId)', async () => {
        const created = await store.recordDispatch(baseInput());
        expect(await store.getByHarnessSession('claude', 'sess-1')).toEqual(created);
      });
    });

    describe('the (harness, harnessSessionId) unique index', () => {
      it('rejects a raw duplicate insert — the DB backstops a racing double-record', async () => {
        await store.recordDispatch(baseInput());
        // A second row with the SAME natural key, bypassing recordDispatch's
        // read-then-upsert, must be rejected by the schema's unique index. The
        // libsql async driver wraps the raw UNIQUE error onto `.cause` (ADR-0029),
        // so detect it via isUniqueViolation walking the cause chain rather than a
        // message regex.
        let caught: unknown;
        try {
          await asyncDb.write((d) =>
            d
              .insert(sessions)
              .values({
                harness: 'claude',
                harnessSessionId: 'sess-1',
                model: 'racing',
                cwd: '/tmp/work',
                status: 'active',
                lastActiveAt: now,
                createdAt: now,
                updatedAt: now,
              })
              .run(),
          );
        } catch (err) {
          caught = err;
        }
        expect(isUniqueViolation(caught)).toBe(true);
      });

      it('allows the same harnessSessionId under a different harness', async () => {
        await store.recordDispatch(baseInput({ harness: 'claude' }));
        await expect(store.recordDispatch(baseInput({ harness: 'codex' }))).resolves.not.toThrow();
      });
    });
  });
});
