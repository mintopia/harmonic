import { createClient, type Client } from '@libsql/client';
import { join } from 'node:path';

// libsql's default is 0 ms: a lock another connection holds for an instant (a checkpoint, a CLI command) fails the call outright.
const LOCK_WAIT_MS = 250;

export function harmonicDbPath(dataDir: string): string {
  return join(dataDir, 'harmonic.db');
}

export function openHarmonicDbClient(dataDir: string): Client {
  return createClient({ url: `file:${harmonicDbPath(dataDir)}`, timeout: LOCK_WAIT_MS });
}
