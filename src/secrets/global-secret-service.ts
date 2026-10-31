import { eq } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { globalSecrets } from '../db/schema.js';
import { DomainError } from '../domain/errors.js';
import { openSecret, sealSecret } from './secret-crypto.js';

export interface GlobalSecretStatus {
  name: string;
  updatedAt: number;
}

/** Only `reveal` returns a value. */
export class GlobalSecretService {
  constructor(private readonly db: AsyncDbHandle, private readonly key: Buffer) {}

  private aad(name: string): string {
    return `global:${name}`;
  }

  async set(name: string, value: string): Promise<GlobalSecretStatus> {
    const now = Date.now();
    const values = { ...sealSecret(this.key, this.aad(name), value), updatedAt: now };
    await this.db.write((db) =>
      db.insert(globalSecrets).values({ name, createdAt: now, ...values }).onConflictDoUpdate({ target: globalSecrets.name, set: values }).run(),
    );
    return { name, updatedAt: now };
  }

  async clear(name: string): Promise<void> {
    await this.db.write((db) => db.delete(globalSecrets).where(eq(globalSecrets.name, name)).run());
  }

  async status(name: string): Promise<GlobalSecretStatus | null> {
    const row = await this.db.read((db) =>
      db.select({ name: globalSecrets.name, updatedAt: globalSecrets.updatedAt }).from(globalSecrets).where(eq(globalSecrets.name, name)).get(),
    );
    return row ?? null;
  }

  async reveal(name: string): Promise<string | null> {
    const row = await this.db.read((db) => db.select().from(globalSecrets).where(eq(globalSecrets.name, name)).get());
    if (!row) return null;
    try {
      return openSecret(this.key, this.aad(name), row);
    } catch {
      throw new DomainError('invalid_state', `secret ${name} cannot be decrypted with the current instance key`);
    }
  }
}
