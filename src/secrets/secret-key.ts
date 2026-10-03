import { randomBytes } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger.js';

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
  createKeyFileAtomically(path);
  if ((statSync(path).mode & 0o077) !== 0) {
    chmodSync(path, 0o600);
    logger.warn('secret key file was group/world accessible; restricted to 0600', { path });
  }
  return decodeKey(readFileSync(path, 'utf8'), path);
}

// Write the full key to a private temp file, then hard-link it into place: link fails with EEXIST if another process won, and a reader can never see a half-written file.
function createKeyFileAtomically(path: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${randomBytes(KEY_BYTES).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  try {
    linkSync(tmp, path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    unlinkSync(tmp);
  }
}
