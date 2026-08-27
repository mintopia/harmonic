import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@libsql/client';

/**
 * Migration 0057 (ADR-0044 §D, issue #338) converts the per-Workspace
 * command-verifier override to list-grain in place. This drives the *actual*
 * `.sql` file — split on drizzle's statement breakpoint, comments stripped —
 * against an in-memory table, so the test can't drift from the shipped migration.
 */
const migrationPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle', '0057_command_verifier_list_grain.sql');

function migrationStatements(): string[] {
  return readFileSync(migrationPath, 'utf8')
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0);
}

describe('0057 command-verifier list-grain migration (ADR-0044 §D, issue #338)', () => {
  it('rewrites off-sentinel and single-command rows to arrays, leaving arrays and inherit (null) untouched', async () => {
    const db = createClient({ url: ':memory:' });
    await db.execute('CREATE TABLE workspaces (id integer primary key, verification_command text)');

    const single = { command: 'npm', args: ['test'], env: {}, timeoutSeconds: 600 };
    const array = [single, { command: 'npm', args: ['run', 'lint'], env: {}, timeoutSeconds: 300 }];
    const rowsIn: Array<[number, string | null]> = [
      [1, null], // inherit
      [2, JSON.stringify({ off: true })], // off sentinel
      [3, JSON.stringify(single)], // single command object
      [4, JSON.stringify(array)], // already a list
    ];
    for (const [id, value] of rowsIn) {
      await db.execute({ sql: 'INSERT INTO workspaces (id, verification_command) VALUES (?, ?)', args: [id, value] });
    }

    for (const stmt of migrationStatements()) await db.execute(stmt);

    const rows = (await db.execute('SELECT id, verification_command FROM workspaces ORDER BY id')).rows;
    const val = (id: number) => rows.find((r) => Number(r.id) === id)!.verification_command as string | null;

    expect(val(1)).toBeNull(); // inherit untouched
    expect(JSON.parse(val(2)!)).toEqual([]); // {off:true} -> [] (off)
    expect(JSON.parse(val(3)!)).toEqual([single]); // single -> [single]
    expect(JSON.parse(val(4)!)).toEqual(array); // list untouched, order preserved
  });
});
