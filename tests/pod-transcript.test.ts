import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PodStepTranscript, PodTranscriptMirror } from '../src/execution/pod-transcript.js';
import { hostExec, hostStream } from './fake-pod-api.js';

const SESSION = 'sess-1';

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('PodTranscriptMirror', () => {
  let dir: string;
  let home: string;
  let source: string;
  let mirrorDir: string;
  let previousHome: string | undefined;

  const pod = {
    run: (script: string, env: Record<string, string>, timeoutMs: number) => hostExec(['sh', '-c', script], { env, timeoutMs }, {}),
    streamFile: async (file: string, follow: boolean) => hostStream(follow ? ['tail', '-F', '-c', '+1', file] : ['cat', file], {}, {}),
  };
  const mirrorFile = (): string => join(mirrorDir, 'claude', SESSION, `${SESSION}.jsonl`);
  const mirrored = (): Buffer => {
    try {
      return readFileSync(mirrorFile());
    } catch {
      return Buffer.alloc(0);
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harmonic-pod-transcript-'));
    home = join(dir, 'home');
    mirrorDir = join(dir, 'mirror');
    source = join(home, '.claude', 'projects', '-work', `${SESSION}.jsonl`);
    mkdirSync(join(home, '.claude', 'projects', '-work'), { recursive: true });
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends session file lines live, and ends byte-for-byte equal to the in-pod file', async () => {
    writeFileSync(source, '{"line":"héllo ✓"}\n');
    const mirror = new PodTranscriptMirror(pod, 'claude', mirrorDir, SESSION);
    mirror.start();

    await until(() => mirrored().toString('utf8').includes('héllo ✓'), 'the first line to be mirrored');
    appendFileSync(source, '{"line":"日本語 🚀"}\n');
    await until(() => mirrored().toString('utf8').includes('日本語 🚀'), 'the appended line to be mirrored live');

    appendFileSync(source, Buffer.concat([Buffer.from('{"line":"'), Buffer.from([0xe2, 0x82]), Buffer.from('"}\n')]));
    appendFileSync(source, '{"line":"last €"}\n');
    const path = await mirror.finish();

    expect(path).toBe(mirrorFile());
    expect(readFileSync(path!).equals(readFileSync(source))).toBe(true);
  });

  it('binds the Session and step log to the live mirror before the step ends', async () => {
    writeFileSync(source, '{"line":"live"}\n');
    const recorded: { transcriptPath?: string | null }[] = [];
    const updates: object[] = [];
    const stepLinks: object[] = [];
    const transcript = new PodStepTranscript(
      {
        dir: mirrorDir,
        sessions: { recordDispatch: async (input: { transcriptPath?: string | null }) => (recorded.push(input), { id: 7 }) } as never,
        attempts: {
          get: async () => ({ usage: null }),
          update: async (_id: number, patch: object) => (updates.push(patch), {}),
          listSteps: async () => [{ id: 3, type: 'implementation', state: 'running' }],
          updateStep: async (_id: number, patch: object) => (stepLinks.push(patch), {}),
        } as never,
      },
      { pod, task: { workspaceId: null }, run: { id: 1 } as never, harnessId: 'claude', model: 'm', cwd: '/w', kind: 'agent', stepId: 's' },
    );
    await transcript.onSessionCreated(SESSION, {} as never);

    await until(() => stepLinks.length > 0, 'the step log to be linked while the step runs');
    expect(recorded[0]?.transcriptPath).toBe(mirrorFile());
    expect(updates[0]).toEqual({ sessionId: SESSION, sessionRowId: 7 });
    expect(stepLinks[0]).toEqual({ logLocator: 'session:7' });
    expect(mirrored().toString('utf8')).toContain('live');
    await transcript.finish();
  });

  it('copies out a file that only appeared after the tail was stopped', async () => {
    const mirror = new PodTranscriptMirror(pod, 'claude', mirrorDir, SESSION, []);
    mirror.start();
    writeFileSync(source, '{"line":"late ü"}\n');
    const path = await mirror.finish();

    expect(readFileSync(path!).equals(readFileSync(source))).toBe(true);
  });

  it('resolves null and never throws when the session file does not exist', async () => {
    const mirror = new PodTranscriptMirror(pod, 'claude', mirrorDir, SESSION, []);
    mirror.start();
    expect(await mirror.finish()).toBeNull();
  });

  it('refuses a session id that could escape the search pattern', async () => {
    writeFileSync(source, 'x\n');
    const mirror = new PodTranscriptMirror(pod, 'claude', mirrorDir, `${SESSION}'; touch ${join(dir, 'pwned')}; '`, []);
    mirror.start();
    expect(await mirror.finish()).toBeNull();
  });
});
