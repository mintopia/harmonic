import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SECRET_KEY_FILE = 'secret.key';
export const SECRET_KEY_ENV = 'HARMONIC_SECRET_KEY';
const KEY_BYTES = 32;

function decodeKey(text: string, source: string): Buffer {
  const trimmed = text.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed) ? Buffer.from(trimmed, 'hex') : Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) throw new Error(`${source} must hold a 32-byte key as 64 hex characters or base64`);
  return key;
}

/** `HARMONIC_SECRET_KEY` wins; otherwise the `0600` key file in the data directory, created on first use. */
export function loadSecretKey(dataDir: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  const fromEnv = env[SECRET_KEY_ENV];
  if (fromEnv) return decodeKey(fromEnv, SECRET_KEY_ENV);
  const path = join(dataDir, SECRET_KEY_FILE);
  mkdirSync(dataDir, { recursive: true });
  try {
    writeFileSync(path, `${randomBytes(KEY_BYTES).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return decodeKey(readFileSync(path, 'utf8'), path);
}
