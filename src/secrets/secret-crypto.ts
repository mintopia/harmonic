import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface SealedSecret {
  ciphertext: string;
  nonce: string;
}

/** `aad` binds the ciphertext to its row; the tag is appended to `ciphertext`. */
export function sealSecret(key: Buffer, aad: string, value: string): SealedSecret {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  return { ciphertext, nonce: nonce.toString('base64') };
}

export function openSecret(key: Buffer, aad: string, sealed: SealedSecret): string {
  const blob = Buffer.from(sealed.ciphertext, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(blob.subarray(blob.length - TAG_BYTES));
  return Buffer.concat([decipher.update(blob.subarray(0, blob.length - TAG_BYTES)), decipher.final()]).toString('utf8');
}
