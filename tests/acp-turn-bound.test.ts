import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { AcpConnection, AcpConnectionClosedError } from '../src/acp/connection.js';
import { AcpDriver, AcpPromptTimeoutError } from '../src/acp/driver.js';

/**
 * Issue #426 — bounding a single ACP prompt turn so a completed turn whose
 * `session/prompt` response is never delivered ends the turn instead of
 * blocking the drive loop until the 60m wall-clock guardrail. Two seams:
 * the connection's stdout-EOF rejection (readline `close`), and the driver's
 * per-turn inactivity timeout (suspended while a tool call is outstanding).
 */

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
    // The response never arrives; the harness closes stdout instead.
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
    conn.dispose(); // sets closed first, then closes readline
    // dispose() rejects nothing itself, but the run-end fail() a caller pairs
    // with it is what settles pending — assert the close handler did not double
    // up by rejecting with the EOF error. We settle it via fail() here.
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
    // `exit: hang` runs the scenario updates then never sends the prompt
    // response and never exits — the lost-response case.
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

  it('suspends the inactivity bound while a tool call is outstanding', async () => {
    const driver = spawnDriver(200);
    await driver.handshake({ cwd: '/tmp/tool' });
    // A tool_call opens, a 600ms gap (> the 200ms bound) passes while it is
    // outstanding, then it completes and the turn ends. The bound must stay
    // suspended across that gap, so the turn resolves normally instead of
    // tripping the timeout.
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
