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
export function loadSecretKey(dataDir: string, env: NodeJS.ProcessEnv = process.env, link: typeof linkSync = linkSync): Buffer {
  const fromEnv = env[SECRET_KEY_ENV];
  if (fromEnv) return decodeKey(fromEnv, SECRET_KEY_ENV);
  const path = join(dataDir, SECRET_KEY_FILE);
  mkdirSync(dataDir, { recursive: true });
  createKeyFileAtomically(path, link);
  if ((statSync(path).mode & 0o077) !== 0) {
    chmodSync(path, 0o600);
    logger.warn('secret key file was group/world accessible; restricted to 0600', { path });
  }
  return decodeKey(readFileSync(path, 'utf8'), path);
}

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EXDEV']);

// Write the full key to a private temp file, then hard-link it into place: link fails with EEXIST if another process won, and a reader can never see a half-written file.
// Filesystems without hard links fall back to an exclusive create of the key file itself.
function createKeyFileAtomically(path: string, link: typeof linkSync): void {
  const content = `${randomBytes(KEY_BYTES).toString('hex')}\n`;
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
  try {
    link(tmp, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return;
    if (!code || !LINK_UNSUPPORTED.has(code)) throw err;
    try {
      writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
    } catch (writeErr) {
      if ((writeErr as NodeJS.ErrnoException).code !== 'EEXIST') throw writeErr;
    }
  } finally {
    unlinkSync(tmp);
  }
}
