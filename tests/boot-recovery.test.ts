import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { startServer, type TestServer } from './helpers.js';

/**
 * Boot crash-recovery: a fresh process executes nothing, so any Task left
 * `running` by the previous instance was orphaned by the restart and must be
 * failed — including a mirrored afk Task that crashed between the ready→running
 * flip (the lock) and its Run being created. That one has no orphaned Run row
 * for the run sweep to mark, and the poll refuses to move a Task off `running`,
 * so before this sweep it stayed stuck `running` forever while its ticket
 * stayed open.
 */
describe('boot crash-recovery', () => {
  let server: TestServer;

  afterEach(async () => {
    await server.close();
  });

  it('fails a Task stuck `running` with no Run row on the next boot', async () => {
    server = await startServer();
    const created = await server.api('POST', '/api/tasks', { prompt: 'stuck mid-launch' });
    const id = created.body.id as number;
    const dataDir = server.dataDir;

    // Simulate the crash: the auto-runner had flipped it to `running` but died
    // before spawning a Run — so there is no `running` run for the run sweep.
    await server.app.close();
    const sqlite = new Database(join(dataDir, 'harmonic.db'));
    sqlite.prepare('UPDATE tasks SET state = ? WHERE id = ?').run('running', id);
    sqlite.close();

    server = await startServer(undefined, { dataDir });
    const recovered = await server.api('GET', `/api/tasks/${id}`);
    expect(recovered.body.state).toBe('failed');
  });
});
