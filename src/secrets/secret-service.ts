import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AsyncDbHandle } from '../db/async.js';
import { secrets } from '../db/schema.js';
import { DomainError } from '../domain/errors.js';
import { openSecret, sealSecret } from './secret-crypto.js';

export const secretNameSchema = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'a secret name is 1-64 letters, digits, `_`, `.` or `-`');
export const secretValueSchema = z.string().min(1).max(8192);

export interface SecretStatus {
  name: string;
  updatedAt: number;
}

/** Per-Workspace named credentials, encrypted at rest. Only `reveal` returns a value; adapters call it, no API route does. */
export class SecretService {
  constructor(private readonly db: AsyncDbHandle, private readonly key: Buffer) {}

  /** Workspace id and name are authenticated data, so a ciphertext copied to another row fails to decrypt. */
  private aad(workspaceId: number, name: string): string {
    return `${workspaceId}:${name}`;
  }

  async set(workspaceId: number, name: string, value: string): Promise<void> {
    const now = Date.now();
    const values = { ...sealSecret(this.key, this.aad(workspaceId, name), value), updatedAt: now };
    await this.db.write((db) =>
      db
        .insert(secrets)
        .values({ workspaceId, name, createdAt: now, ...values })
        .onConflictDoUpdate({ target: [secrets.workspaceId, secrets.name], set: values })
        .run(),
    );
  }

  async clear(workspaceId: number, name: string): Promise<void> {
    await this.db.write((db) => db.delete(secrets).where(and(eq(secrets.workspaceId, workspaceId), eq(secrets.name, name))).run());
  }

  async has(workspaceId: number, name: string): Promise<boolean> {
    const row = await this.db.read((db) =>
      db.select({ name: secrets.name }).from(secrets).where(and(eq(secrets.workspaceId, workspaceId), eq(secrets.name, name))).get(),
    );
    return row !== undefined;
  }

  async list(workspaceId: number): Promise<SecretStatus[]> {
    return this.db.read((db) =>
      db.select({ name: secrets.name, updatedAt: secrets.updatedAt }).from(secrets).where(eq(secrets.workspaceId, workspaceId)).orderBy(secrets.name).all(),
    );
  }

  async reveal(workspaceId: number, name: string): Promise<string | null> {
    const row = await this.db.read((db) =>
      db.select().from(secrets).where(and(eq(secrets.workspaceId, workspaceId), eq(secrets.name, name))).get(),
    );
    if (!row) return null;
    try {
      return openSecret(this.key, this.aad(workspaceId, name), row);
    } catch {
      throw new DomainError('invalid_state', `secret ${name} cannot be decrypted with the current instance key`);
    }
  }
}
