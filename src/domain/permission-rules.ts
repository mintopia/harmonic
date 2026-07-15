import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
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
  constructor(private readonly db: Db) {}

  /** Idempotent: a rule for the same (kind, dir) is returned rather than duplicated. */
  create(input: CreatePermissionRuleInput): PermissionRuleRow {
    const existing = this.findMatch(input.kind, input.workingDir);
    if (existing) return existing;
    return this.db
      .insert(permissionRules)
      .values({ kind: input.kind, workingDir: input.workingDir, createdAt: Date.now() })
      .returning()
      .get();
  }

  list(): PermissionRuleRow[] {
    return this.db.select().from(permissionRules).orderBy(desc(permissionRules.createdAt)).all();
  }

  get(id: number): PermissionRuleRow {
    const row = this.db.select().from(permissionRules).where(eq(permissionRules.id, id)).get();
    if (!row) throw new DomainError('not_found', `permission rule ${id} not found`);
    return row;
  }

  delete(id: number): void {
    this.get(id); // 404 on unknown
    this.db.delete(permissionRules).where(eq(permissionRules.id, id)).run();
  }

  /** The rule matching a permission request's tool kind + Working Directory, or null. */
  findMatch(kind: string, workingDir: string): PermissionRuleRow | null {
    return (
      this.db
        .select()
        .from(permissionRules)
        .where(and(eq(permissionRules.kind, kind), eq(permissionRules.workingDir, workingDir)))
        .get() ?? null
    );
  }
}
