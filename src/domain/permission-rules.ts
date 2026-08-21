import { and, desc, eq } from 'drizzle-orm';
import type { AsyncDbHandle } from '../db/async.js';
import { permissionRules, type PermissionRuleRow } from '../db/schema.js';
import { DomainError } from './errors.js';

export interface CreatePermissionRuleInput {
  /** ACP tool kind (read / edit / execute / fetch). */
  kind: string;
  workingDir: string;
}

/**
 * Persistent Permission Rules (ADR-0007): the opt-in tier that auto-answers
 * a Harness's permission request when the tool kind and Working Directory
 * match — across the same and new Conversations. Operator-visible and
 * revocable in Settings.
 */
export class PermissionRuleStore {
  constructor(private readonly db: AsyncDbHandle) {}

  /**
   * Idempotent: a rule for the same (kind, dir) is returned rather than
   * duplicated. The match read and the insert run as a single
   * `this.db.write()` unit (ADR-0029 §3): the async single-writer queue
   * stands in for better-sqlite3's synchrony, so no concurrent `create` can
   * interleave between the match check and the insert and produce a
   * duplicate row.
   */
  create(input: CreatePermissionRuleInput): Promise<PermissionRuleRow> {
    return this.db.write(async (db) => {
      const existing = await db
        .select()
        .from(permissionRules)
        .where(and(eq(permissionRules.kind, input.kind), eq(permissionRules.workingDir, input.workingDir)))
        .get();
      if (existing) return existing;
      return db
        .insert(permissionRules)
        .values({ kind: input.kind, workingDir: input.workingDir, createdAt: Date.now() })
        .returning()
        .get();
    });
  }

  list(): Promise<PermissionRuleRow[]> {
    return this.db.read((db) => db.select().from(permissionRules).orderBy(desc(permissionRules.createdAt)).all());
  }

  async get(id: number): Promise<PermissionRuleRow> {
    const row = await this.db.read((db) => db.select().from(permissionRules).where(eq(permissionRules.id, id)).get());
    if (!row) throw new DomainError('not_found', `permission rule ${id} not found`);
    return row;
  }

  /** 404-checks and deletes as a single `this.db.write()` unit (ADR-0029 §3). */
  delete(id: number): Promise<void> {
    return this.db.write(async (db) => {
      const row = await db.select().from(permissionRules).where(eq(permissionRules.id, id)).get();
      if (!row) throw new DomainError('not_found', `permission rule ${id} not found`);
      await db.delete(permissionRules).where(eq(permissionRules.id, id)).run();
    });
  }

  /** The rule matching a permission request's tool kind + Working Directory, or null. */
  async findMatch(kind: string, workingDir: string): Promise<PermissionRuleRow | null> {
    const row = await this.db.read((db) =>
      db
        .select()
        .from(permissionRules)
        .where(and(eq(permissionRules.kind, kind), eq(permissionRules.workingDir, workingDir)))
        .get(),
    );
    return row ?? null;
  }
}
