import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runTimedCriticDrive,
  createAcpCriticDrive,
  type CriticHarnessDrive,
  type CriticDriveRequest,
} from '../src/verification/critic.js';
import type { HarnessConfig } from '../src/config.js';
import { testSpawnProcessGroup } from './helpers.js';
describe('createAcpCriticDrive (issue #136): the real ACP drive has builder-equivalent tool access, no tracker path', () => {
  const STUB_HARNESS = join(import.meta.dirname, 'stub-harness.mjs');
  const tmpDirs: string[] = [];
  const freshCwd = () => {
    const dir = mkdtempSync(join(tmpdir(), 'harmonic-critic-drive-cwd-'));
    tmpDirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  const harness: HarnessConfig = {
    command: process.execPath,
    args: [STUB_HARNESS],
    env: { HARMONIC_API_KEY: 'leaked-key', HARMONIC_MCP_URL: 'http://leaked' },
    models: [{ id: 'stub-model' }],
    defaultModel: 'stub-model',
    cacheWarmSeconds: 300,
  };

  it('registers no MCP servers, strips tracker credentials from the spawned env, and grants tool permission requests', async () => {
    const drive = createAcpCriticDrive(testSpawnProcessGroup);
    const scenario = {
      echoSessionNew: true,
      echoEnv: ['HARMONIC_API_KEY', 'HARMONIC_MCP_URL'],
      requestPermission: { title: 'edit a file', kind: 'edit' },
    };

    const result = await drive.run({
      harness,
      harnessId: 'claude',
      model: 'stub-model',
      cwd: freshCwd(),
      prompt: JSON.stringify(scenario),
      timeoutMs: 15_000,
    });

    expect(result.output).toContain('"mcpServers":[]');
    expect(result.output).toContain('"HARMONIC_API_KEY":null');
    expect(result.output).toContain('"HARMONIC_MCP_URL":null');
    expect(result.output).toContain('permission:{"outcome":"selected","optionId":"always"}');
    expect(result.permissionRequests).toHaveLength(1);
  }, 20_000);

  it('rejects when the harness hangs past the timeout, without leaving the child alive', async () => {
    const drive = createAcpCriticDrive(testSpawnProcessGroup);
    await expect(
      drive.run({
        harness,
        harnessId: 'claude',
        model: 'stub-model',
        cwd: freshCwd(),
        prompt: JSON.stringify({ exit: 'hang' }),
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/timed out/i);
  }, 10_000);
});

describe('runTimedCriticDrive', () => {
  const request = { harness: {}, harnessId: 'claude', model: 'm', cwd: '/tmp', prompt: 'p', timeoutMs: 1000 } as unknown as CriticDriveRequest;

  it('does not let a failing duration write mask the drive error', async () => {
    const drive: CriticHarnessDrive = { run: async () => { throw new Error('prompt failed'); } };
    await expect(runTimedCriticDrive(drive, request, async () => { throw new Error('db down'); })).rejects.toThrow('prompt failed');
  });

  it('records the duration once when the drive reports it itself', async () => {
    const record = vi.fn(async () => {});
    const drive: CriticHarnessDrive = {
      run: async (req) => {
        await req.onAgentDurationMs?.(5);
        return { output: '', permissionRequests: [], sessionId: null };
      },
    };
    await runTimedCriticDrive(drive, request, record);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(5);
  });
});
