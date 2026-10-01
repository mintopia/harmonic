import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// `void <promise>` detaches work that app shutdown cannot await, so it can outlive the DB close.
// Background work goes through fireAndForget or an InFlight; only these deliberate exceptions may use `void`.
const ALLOWED: ReadonlyArray<{ file: string; snippet: string; count?: number; reason: string }> = [
  { file: 'src/telemetry.ts', snippet: 'void flushMetricSummary()', reason: 'logs a metrics summary, no DB; shutdown runs its own final flush' },
  { file: 'src/tracker/poller.ts', snippet: 'void this.poll().catch(', count: 2, reason: 'poll() tracks itself; stop() drains it' },
  { file: 'src/scheduler/scheduler.ts', snippet: 'void job.tick()', reason: 'job.tick() tracks itself; stop() drains it' },
  { file: 'src/domain/workspace-watcher.ts', snippet: 'void readGitStatus(root)', reason: 'git status read feeding a UI event; nothing persisted' },
  { file: 'src/server/app-routes.ts', snippet: 'void transport.close()', reason: 'in-memory MCP transport teardown' },
  { file: 'src/server/app-routes.ts', snippet: 'void mcp.close()', reason: 'in-memory MCP server teardown' },
  { file: 'src/server/routes/task-export.ts', snippet: 'void rm(built.path', reason: 'temp-file cleanup after the download stream closes' },
  { file: 'src/verification/command-verifier.ts', snippet: 'void fileClosed.then(', reason: 'settles the awaited command promise once its log file closes' },
  { file: 'src/upgrade/upgrade-coordinator.ts', snippet: 'void (async () => {', reason: 'the upgrade swap closes the app itself; tracking it would make shutdown wait on itself' },
  { file: 'src/db/stats-reader.ts', snippet: 'void this.close()', reason: 'stats worker-thread teardown; no main DB handle' },
  { file: 'src/db/stats-reader.ts', snippet: 'void this.#worker.terminate()', reason: 'stats worker-thread teardown; no main DB handle' },
  { file: 'src/upgrade/relauncher.ts', snippet: 'void main()', reason: 'process entry point' },
];

const VOID_CALL = /\bvoid[ \t]+[A-Za-z_$(]/;

function sourceFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((name) => /\.tsx?$/.test(name) && !name.endsWith('.d.ts'))
    .map((name) => join(dir, name));
}

describe('no untracked void promises in src', () => {
  it('every `void <expr>` is on the allowlist, and every allowlist entry still exists', () => {
    const root = join(import.meta.dirname, '..');
    const found: Array<{ file: string; line: string }> = [];
    for (const path of sourceFiles(join(root, 'src'))) {
      const file = relative(root, path);
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        if (VOID_CALL.test(line)) found.push({ file, line: trimmed });
      }
    }

    const unexpected = found.filter(({ file, line }) => !ALLOWED.some((entry) => entry.file === file && line.includes(entry.snippet)));
    expect(unexpected, 'route background work through fireAndForget or an InFlight, or allowlist it with a reason').toEqual([]);

    const stale = ALLOWED.filter((entry) => found.filter(({ file, line }) => entry.file === file && line.includes(entry.snippet)).length !== (entry.count ?? 1));
    expect(stale).toEqual([]);
  });
});
