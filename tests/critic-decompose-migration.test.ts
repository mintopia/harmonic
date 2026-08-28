import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@libsql/client';

/**
 * Migration 0059 (ADR-0044 §C, issue #337) decomposes the atomic critic
 * override into four independently-inheritable scalar columns. This drives
 * the *actual* `.sql` file — split on drizzle's statement breakpoint,
 * comments stripped — against an in-memory table, so the test can't drift
 * from the shipped migration.
 */
const migrationPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle', '0059_decompose_review_override.sql');

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

describe('0059 critic-decompose migration (ADR-0044 §C, issue #337)', () => {
  it('splits every verification_critic encoding into the four review_* columns', async () => {
    const db = createClient({ url: ':memory:' });
    await db.execute('CREATE TABLE workspaces (id integer primary key, verification_critic text)');

    const rowsIn: Array<[number, string | null]> = [
      [1, null], // inherit
      [2, JSON.stringify({ off: true })], // off sentinel
      [3, JSON.stringify({ prompt: 'p', model: 'm' })], // bare critic
      [4, JSON.stringify({ prompt: 'p2', model: 'm2', harness: 'claude' })], // bare critic + harness
      [5, JSON.stringify({ enabled: true, prompt: 'p3', model: 'm3' })], // review-shaped
      [6, JSON.stringify({ enabled: false })], // review-shaped, disabled
    ];
    for (const [id, value] of rowsIn) {
      await db.execute({ sql: 'INSERT INTO workspaces (id, verification_critic) VALUES (?, ?)', args: [id, value] });
    }

    for (const stmt of migrationStatements()) await db.execute(stmt);

    const rows = (
      await db.execute('SELECT id, review_enabled, review_prompt, review_model, review_harness FROM workspaces ORDER BY id')
    ).rows;
    const row = (id: number) => rows.find((r) => Number(r.id) === id)!;

    const r1 = row(1);
    expect(r1.review_enabled).toBeNull();
    expect(r1.review_prompt).toBeNull();
    expect(r1.review_model).toBeNull();
    expect(r1.review_harness).toBeNull();

    const r2 = row(2);
    expect(Number(r2.review_enabled)).toBe(0);
    expect(r2.review_prompt).toBeNull();
    expect(r2.review_model).toBeNull();
    expect(r2.review_harness).toBeNull();

    const r3 = row(3);
    expect(Number(r3.review_enabled)).toBe(1);
    expect(r3.review_prompt).toBe('p');
    expect(r3.review_model).toBe('m');
    expect(r3.review_harness).toBeNull();

    const r4 = row(4);
    expect(Number(r4.review_enabled)).toBe(1);
    expect(r4.review_prompt).toBe('p2');
    expect(r4.review_model).toBe('m2');
    expect(r4.review_harness).toBe('claude');

    const r5 = row(5);
    expect(Number(r5.review_enabled)).toBe(1);
    expect(r5.review_prompt).toBe('p3');
    expect(r5.review_model).toBe('m3');
    expect(r5.review_harness).toBeNull();

    const r6 = row(6);
    expect(Number(r6.review_enabled)).toBe(0);
    expect(r6.review_prompt).toBeNull();
    expect(r6.review_model).toBeNull();
    expect(r6.review_harness).toBeNull();
  });
});
