import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { AcpConnection, AcpConnectionClosedError } from '../src/acp/connection.js';
import { AcpDriver, AcpPromptTimeoutError } from '../src/acp/driver.js';

const STUB_HARNESS = join(import.meta.dirname, 'stub-harness.mjs');
const scenario = (s: object) => JSON.stringify(s);

describe('AcpConnection — stdout EOF rejects pending requests (issue #426)', () => {
  it('rejects an in-flight request with AcpConnectionClosedError when stdout ends', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new AcpConnection(stdin, stdout, {
      onSessionUpdate: () => {},
      onRequest: async () => null,
    });
    const pending = conn.request('session/prompt', { sessionId: 's' });
    stdout.end();
    await expect(pending).rejects.toBeInstanceOf(AcpConnectionClosedError);
  });

  it('a deliberate dispose() does not surface as an EOF rejection', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const conn = new AcpConnection(stdin, stdout, {
      onSessionUpdate: () => {},
      onRequest: async () => null,
    });
    const pending = conn.request('session/prompt', { sessionId: 's' });
    conn.dispose();
    conn.fail(new Error('run finished'));
    await expect(pending).rejects.toThrow('run finished');
  });
});

describe('AcpDriver — per-turn inactivity timeout (issue #426)', () => {
  let activeChild: ChildProcess | undefined;
  afterEach(() => {
    activeChild?.kill();
    activeChild = undefined;
  });

  function spawnDriver(promptInactivityTimeoutMs?: number): AcpDriver {
    const child = spawn(process.execPath, [STUB_HARNESS], { stdio: ['pipe', 'pipe', 'pipe'] });
    activeChild = child;
    return new AcpDriver(
      child,
      { onSessionUpdate: () => {}, onRequest: async () => null },
      promptInactivityTimeoutMs,
    );
  }

  it('rejects a silent (never-responding) turn with AcpPromptTimeoutError', async () => {
    const driver = spawnDriver(200);
    await driver.handshake({ cwd: '/tmp/eof' });
    await expect(driver.prompt([{ type: 'text', text: scenario({ exit: 'hang' }) }])).rejects.toBeInstanceOf(
      AcpPromptTimeoutError,
    );
  }, 15_000);

  it('does not time out a normal turn that responds promptly', async () => {
    const driver = spawnDriver(200);
    await driver.handshake({ cwd: '/tmp/ok' });
    const result = await driver.prompt([
      { type: 'text', text: scenario({ updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }], stopReason: 'end_turn' }) },
    ]);
    expect(result.stopReason).toBe('end_turn');
  }, 15_000);

  it('a completion signal bounds the turn on a short grace despite an outstanding tool', async () => {
    const driver = spawnDriver(60_000);
    await driver.handshake({ cwd: '/tmp/finish' });
    const turn = driver.prompt([
      {
        type: 'text',
        text: scenario({
          exit: 'hang',
          updates: [{ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'sub-agent', kind: 'other', status: 'pending' }],
        }),
      },
    ]);
    await new Promise((r) => setTimeout(r, 100));
    driver.expectCompletion(200);
    await expect(turn).rejects.toBeInstanceOf(AcpPromptTimeoutError);
  }, 15_000);

  it('suspends the inactivity bound while a tool call is outstanding', async () => {
    const driver = spawnDriver(200);
    await driver.handshake({ cwd: '/tmp/tool' });
    const result = await driver.prompt([
      {
        type: 'text',
        text: scenario({
          delayMs: 600,
          updates: [
            { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Build', kind: 'execute', status: 'pending' },
            { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' },
          ],
          stopReason: 'end_turn',
        }),
      },
    ]);
    expect(result.stopReason).toBe('end_turn');
  }, 15_000);
});
