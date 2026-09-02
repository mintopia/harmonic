import type { Client } from '@libsql/client';
import { logger } from '../logger.js';

/**
 * The declarative schema: `drizzle/0000_baseline.sql` as drizzle-kit emits it —
 * one statement per `--> statement-breakpoint`, table bodies one column or
 * constraint per line.
 */
export interface BaselineTable {
  name: string;
  sql: string;
  columns: { name: string; definition: string }[];
}

export interface BaselineIndex {
  name: string;
  sql: string;
}

export interface Baseline {
  tables: BaselineTable[];
  indexes: BaselineIndex[];
}

export function parseBaseline(sql: string): Baseline {
  const baseline: Baseline = { tables: [], indexes: [] };
  for (const raw of sql.split('--> statement-breakpoint')) {
    const statement = raw.trim().replace(/;$/, '');
    if (!statement) continue;
    const table = /^CREATE TABLE `(\w+)` \(([\s\S]*)\)$/.exec(statement);
    if (table) {
      const columns = table[2]!
        .split('\n')
        .map((line) => line.trim().replace(/,$/, ''))
        .filter((line) => line.startsWith('`'))
        .map((definition) => ({ name: /^`(\w+)`/.exec(definition)![1]!, definition }));
      baseline.tables.push({ name: table[1]!, sql: statement, columns });
      continue;
    }
    const index = /^CREATE (?:UNIQUE )?INDEX `(\w+)`/.exec(statement);
    if (index) {
      baseline.indexes.push({ name: index[1]!, sql: statement });
      continue;
    }
    throw new Error(`unsupported baseline statement: ${statement.slice(0, 60)}`);
  }
  return baseline;
}

async function liveNames(client: Client, type: 'table' | 'index'): Promise<string[]> {
  return (
    await client.execute(`select name from sqlite_master where type = '${type}' and name not like 'sqlite_%'`)
  ).rows.map((row) => String(row.name));
}

async function convergeIncremental(client: Client, baseline: Baseline): Promise<void> {
  const declaredTables = new Set(baseline.tables.map((t) => t.name));
  const declaredIndexes = new Set(baseline.indexes.map((i) => i.name));
  for (const name of await liveNames(client, 'index')) {
    if (declaredIndexes.has(name)) continue;
    logger.info('schema-sync: dropping index', { index: name });
    await client.execute(`DROP INDEX \`${name}\``);
  }
  for (const name of await liveNames(client, 'table')) {
    if (declaredTables.has(name)) continue;
    logger.info('schema-sync: dropping table', { table: name });
    await client.execute(`DROP TABLE \`${name}\``);
  }
  const existingTables = new Set(await liveNames(client, 'table'));
  for (const table of baseline.tables) {
    if (!existingTables.has(table.name)) {
      await client.execute(table.sql);
      continue;
    }
    const live = (await client.execute(`pragma table_info(\`${table.name}\`)`)).rows.map((row) => String(row.name));
    const declared = new Set(table.columns.map((c) => c.name));
    for (const column of live) {
      if (declared.has(column)) continue;
      logger.info('schema-sync: dropping column', { table: table.name, column });
      await client.execute(`ALTER TABLE \`${table.name}\` DROP COLUMN \`${column}\``);
    }
    for (const column of table.columns) {
      if (!live.includes(column.name)) {
        await client.execute(`ALTER TABLE \`${table.name}\` ADD COLUMN ${column.definition}`);
      }
    }
  }
  for (const index of baseline.indexes) {
    await client.execute(index.sql.replace(/^CREATE (UNIQUE )?INDEX /, 'CREATE $1INDEX IF NOT EXISTS '));
  }
}

/**
 * ADR-0007 clean-break: when in-place convergence can't apply a change (a column
 * type change, a new NOT NULL column without a default), drop every live table and
 * index and recreate the baseline from scratch. Data loss is the intended fallback,
 * not a bug — there is no backup path.
 */
async function cleanBreakRecreate(client: Client, baseline: Baseline): Promise<void> {
  await client.execute('BEGIN');
  try {
    for (const name of await liveNames(client, 'index')) {
      logger.info('schema-sync: clean-break dropping index', { index: name });
      await client.execute(`DROP INDEX \`${name}\``);
    }
    for (const name of await liveNames(client, 'table')) {
      logger.info('schema-sync: clean-break dropping table', { table: name });
      await client.execute(`DROP TABLE \`${name}\``);
    }
    for (const table of baseline.tables) {
      await client.execute(table.sql);
    }
    for (const index of baseline.indexes) {
      await client.execute(index.sql);
    }
    await client.execute('COMMIT');
  } catch (err) {
    await client.execute('ROLLBACK').catch(() => {});
    throw new Error(
      `schema-sync: ADR-0007 clean-break recreate of drizzle/0000_baseline.sql also failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Converge a live database onto the baseline: create missing tables
 * and indexes, add missing columns, drop tables, indexes and columns the
 * baseline no longer declares. No migration history is kept — the baseline is
 * edited in place and every data dir converges on boot. Convergence runs in one
 * transaction so a mid-way failure leaves the database untouched (SQLite DDL is
 * transactional); if convergence still fails after rollback, the ADR-0007
 * clean-break path recreates the whole schema from the baseline instead. Uses
 * raw BEGIN/COMMIT rather than `client.transaction()` so every statement (and
 * the caller's surrounding pragmas) stays on the one shared connection.
 */
export async function syncSchema(client: Client, baselineSql: string): Promise<void> {
  const baseline = parseBaseline(baselineSql);
  await client.execute('BEGIN');
  try {
    await convergeIncremental(client, baseline);
    await client.execute('COMMIT');
  } catch (err) {
    await client.execute('ROLLBACK').catch(() => {});
    logger.warn('schema-sync: incremental convergence failed, falling back to ADR-0007 clean-break recreate', {
      reason: err instanceof Error ? err.message : String(err),
    });
    await cleanBreakRecreate(client, baseline);
  }
}
