import type { Client } from '@libsql/client';

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

/**
 * Converge a live database onto the baseline (ADR-0007): create missing tables
 * and indexes, add missing columns, drop tables, indexes and columns the
 * baseline no longer declares. No migration history is kept — the baseline is
 * edited in place and every data dir converges on boot. A change SQLite cannot
 * apply in place (a column type change, a new NOT NULL column without a
 * default) fails loudly; under the clean-break policy the data dir is recreated.
 */
export async function syncSchema(client: Client, baselineSql: string): Promise<void> {
  const baseline = parseBaseline(baselineSql);
  const names = async (type: 'table' | 'index'): Promise<string[]> =>
    (await client.execute(`select name from sqlite_master where type = '${type}' and name not like 'sqlite_%'`)).rows.map(
      (row) => String(row.name),
    );
  try {
    const declaredTables = new Set(baseline.tables.map((t) => t.name));
    const declaredIndexes = new Set(baseline.indexes.map((i) => i.name));
    for (const name of await names('index')) {
      if (!declaredIndexes.has(name)) await client.execute(`DROP INDEX \`${name}\``);
    }
    for (const name of await names('table')) {
      if (!declaredTables.has(name)) await client.execute(`DROP TABLE \`${name}\``);
    }
    const existingTables = new Set(await names('table'));
    for (const table of baseline.tables) {
      if (!existingTables.has(table.name)) {
        await client.execute(table.sql);
        continue;
      }
      const live = (await client.execute(`pragma table_info(\`${table.name}\`)`)).rows.map((row) => String(row.name));
      const declared = new Set(table.columns.map((c) => c.name));
      for (const column of live) {
        if (!declared.has(column)) await client.execute(`ALTER TABLE \`${table.name}\` DROP COLUMN \`${column}\``);
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
  } catch (err) {
    throw new Error(
      `schema convergence onto drizzle/0000_baseline.sql failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'ADR-0007 clean-break: recreate harmonic.db in the data dir.',
    );
  }
}
