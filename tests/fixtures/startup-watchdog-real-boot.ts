import { createClient } from '@libsql/client';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { parseBaseline } from '../../src/db/schema-sync.js';
import { startStartupWatchdog } from '../../src/cli-serve.js';
import { openAsyncDb } from '../../src/db/async.js';

// Drives the real boot-time DB path (schema convergence + workspace backfill, src/db/async.ts) under
// the real out-of-process startup watcher, with a deliberately tiny deadline. Every baseline table is
// pre-created with a harmless definition drift (an extra CHECK) and populated, so on open every table
// needs schema-sync's real `rebuildTable` row copy (src/db/schema-sync.ts): dozens of real, separately
// awaited steps that together take far longer than one deadline window. Only per-step progress
// touches (not just touches around the whole DB open) can keep this alive.
const dataDirArg = process.argv[2];
const rowsPerTable = Number(process.argv[3] ?? '1500');
if (!dataDirArg) throw new Error('usage: startup-watchdog-real-boot <dataDir> [rowsPerTable]');
const dataDir: string = dataDirArg;

mkdirSync(join(dataDir, 'app'), { recursive: true });

async function seed(): Promise<void> {
  const baselinePath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle', '0000_baseline.sql');
  const baseline = parseBaseline(readFileSync(baselinePath, 'utf8'));
  const client = createClient({ url: `file:${join(dataDir, 'harmonic.db')}` });
  // Baseline tables reference each other by FK before every table exists yet; matches the real boot
  // path (src/db/async.ts), which also converges the schema with foreign keys off.
  await client.execute('PRAGMA foreign_keys = OFF');
  const chunkSize = 500;
  // Only the FK-free tables are drifted and seeded with real rows: with foreign keys off during
  // convergence but checked afterwards (`PRAGMA foreign_key_check`, src/db/async.ts), any FK-bearing
  // table would need matching parent rows to pass. Left un-drifted and empty, those tables still take
  // their own real (fast) `CREATE TABLE` step and trivially satisfy the FK check.
  const seedTables = new Set(baseline.tables.filter((t) => !/FOREIGN KEY/.test(t.sql)).map((t) => t.name));
  for (const table of baseline.tables) {
    if (!seedTables.has(table.name)) continue;
    // A trailing `CHECK` clause is semantically inert but makes the live definition diverge from the
    // baseline's, so schema-sync's `normalizeDefinition` comparison forces `rebuildTable` — dozens of
    // real, separately awaited steps, several of which (the row copies) take long enough that the
    // whole pass reliably spans several deadline windows.
    const driftedSql = table.sql.replace(/\)$/, ', CHECK (1=1))');
    await client.execute(driftedSql);
    // `workspaces` stays tiny: the workspace backfill (src/db/async.ts) sorts it by id on every boot,
    // and a large `workspaces` dwarfs everything else here — this fixture is exercising schema-sync's
    // per-table rebuild steps, not that unrelated sort.
    const rowCount = table.name === 'workspaces' ? Math.min(rowsPerTable, 3) : rowsPerTable;
    const columnNames = table.columns.map((c) => `\`${c.name}\``).join(', ');
    for (let start = 0; start < rowCount; start += chunkSize) {
      const end = Math.min(start + chunkSize, rowCount);
      const values: string[] = [];
      for (let i = start; i < end; i++) {
        const rowValues = table.columns.map((c) => (/integer/i.test(c.definition) ? String(i + 1) : `'v${i + 1}'`));
        values.push(`(${rowValues.join(', ')})`);
      }
      await client.execute(`INSERT INTO \`${table.name}\` (${columnNames}) VALUES ${values.join(', ')}`);
    }
  }
  client.close();
}

await seed();

const watcherPath = fileURLToPath(new URL('../../src/upgrade/startup-watcher.cjs', import.meta.url));
startStartupWatchdog({ dataDir, watcherPath });
process.stdout.write('armed\n');

async function main(): Promise<void> {
  const handle = await openAsyncDb(dataDir);
  await handle.close();
  unlinkSync(join(dataDir, 'app', 'pending.json'));
  process.stdout.write('healthy\n');
}

void main();
