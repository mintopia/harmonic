import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { adapterFor } from '../src/execution/harness/adapter.js';

describe('harness adapters', () => {
  it('claude spawn tweaks pin the model and strip the nested-session guard vars', () => {
    const env = adapterFor('claude').spawnEnv('claude-opus-4-8');
    expect(env.ANTHROPIC_MODEL).toBe('claude-opus-4-8');
    // Present-but-undefined so they override anything inherited from process.env.
    expect(env).toHaveProperty('CLAUDECODE', undefined);
    expect(env).toHaveProperty('CLAUDE_CODE_ENTRYPOINT', undefined);
  });

  it('codex and copilot are stubs: no spawn tweaks beyond the generic AGENTDECK_MODEL', () => {
    expect(adapterFor('codex').spawnEnv('gpt-5.2-codex')).toEqual({});
    expect(adapterFor('copilot').spawnEnv('claude-sonnet-5')).toEqual({});
  });

  it('codex, copilot, and unknown harnesses have no Usage Collector', () => {
    expect(adapterFor('codex').usage).toBeNull();
    expect(adapterFor('copilot').usage).toBeNull();
    expect(adapterFor('mystery').usage).toBeNull();
  });

  it("claude's Usage Collector locates the session log by the cwd-slug convention", () => {
    const usage = adapterFor('claude').usage!;
    expect(
      usage.sessionLogFile({ sessionLogDir: '/logs', cwd: '/tmp/my.work_dir', sessionId: 'abc-123' }),
    ).toBe('/logs/-tmp-my-work-dir/abc-123.jsonl');
    // Default log root when the operator has not configured one.
    expect(usage.sessionLogFile({ cwd: '/w', sessionId: 's1' })).toBe(
      join(homedir(), '.claude', 'projects', '-w', 's1.jsonl'),
    );
    expect(usage.sessionLogFile({ sessionLogDir: '/logs', cwd: '/w', sessionId: null })).toBeNull();
  });
});
