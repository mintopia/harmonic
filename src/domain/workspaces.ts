import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { eq, ne, and } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { workspaces, type WorkspaceRow } from '../db/schema.js';
import { DomainError } from './errors.js';

export const createWorkspaceInputSchema = z.object({
  name: z.string().min(1, 'name is required').meta({ example: 'Harmonic' }),
  workingDir: z.string().min(1, 'workingDir is required').meta({ example: '/home/dev/harmonic' }),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

export const updateWorkspaceInputSchema = createWorkspaceInputSchema.partial();
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceInputSchema>;

/**
 * A Workspace (ADR-0008): a named Working Directory, unique by absolute
 * path. CRUD only — no delete yet (not in scope until a later slice adds
 * per-Workspace execution settings to guard against deleting one mid-run).
 */
export class WorkspaceService {
  constructor(private readonly db: Db) {}

  list(): WorkspaceRow[] {
    return this.db.select().from(workspaces).orderBy(workspaces.createdAt).all();
  }

  get(id: number): WorkspaceRow {
    const row = this.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
    if (!row) throw new DomainError('not_found', `workspace ${id} not found`);
    return row;
  }

  create(input: CreateWorkspaceInput): WorkspaceRow {
    const workingDir = this.assertUsableDir(input.workingDir);
    this.assertUniquePath(workingDir);
    const now = Date.now();
    return this.db
      .insert(workspaces)
      .values({ name: input.name, workingDir, createdAt: now, updatedAt: now })
      .returning()
      .get();
  }

  update(id: number, input: UpdateWorkspaceInput): WorkspaceRow {
    const current = this.get(id);
    const workingDir = input.workingDir !== undefined ? this.assertUsableDir(input.workingDir) : current.workingDir;
    if (workingDir !== current.workingDir) this.assertUniquePath(workingDir, id);
    return this.db
      .update(workspaces)
      .set({ name: input.name ?? current.name, workingDir, updatedAt: Date.now() })
      .where(eq(workspaces.id, id))
      .returning()
      .get()!;
  }

  /** Resolves to an absolute path and rejects one that isn't a real, existing directory. */
  private assertUsableDir(workingDir: string): string {
    const resolved = resolve(workingDir);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new DomainError('validation', `working directory '${workingDir}' does not exist`);
    }
    return resolved;
  }

  private assertUniquePath(workingDir: string, excludeId?: number): void {
    const filters = [eq(workspaces.workingDir, workingDir)];
    if (excludeId !== undefined) filters.push(ne(workspaces.id, excludeId));
    const clash = this.db
      .select()
      .from(workspaces)
      .where(and(...filters))
      .get();
    if (clash) throw new DomainError('conflict', `a workspace already uses '${workingDir}'`);
  }
}
