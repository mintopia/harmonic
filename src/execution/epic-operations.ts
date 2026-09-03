import type { Attributes } from '@opentelemetry/api';
import { startOperation, type Operation } from '../telemetry/operations.js';

export type EpicOperationType = 'cut' | 'member-merge' | 'git.rebase' | 'git.fast-forward' | 'heal' | 'verify' | 'integrate' | 'merge' | 'retire';

/** Keeps one live trace root for an Epic while its work moves between poll ticks. */
export class EpicOperations {
  private readonly roots = new Map<string, Operation>();

  run<T>({ repoDir, epicRef, epicTitle, type, attributes = {}, parent, work }: {
    repoDir: string;
    epicRef: number;
    epicTitle?: string;
    type: EpicOperationType;
    attributes?: Attributes;
    parent?: Operation;
    work: (operation: Operation) => Promise<T>;
  }): Promise<T> {
    const root = this.root(repoDir, epicRef, epicTitle);
    const operation = startOperation({
      type: `epic.${type}`,
      attributes: { 'epic.ref': epicRef, ...attributes },
      parent: parent?.spanContext ?? root.spanContext,
    });
    return operation.run(async () => {
      try {
        const result = await work(operation);
        operation.end();
        return result;
      } catch (error) {
        operation.fail(error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
  }

  fail({ repoDir, epicRef, reason }: { repoDir: string; epicRef: number; reason: string }): void {
    const key = this.key(repoDir, epicRef);
    const root = this.roots.get(key) ?? this.root(repoDir, epicRef);
    root.fail(reason);
    this.roots.delete(key);
  }

  complete({ repoDir, epicRef }: { repoDir: string; epicRef: number }): void {
    const key = this.key(repoDir, epicRef);
    const root = this.roots.get(key);
    if (!root) return;
    root.end();
    this.roots.delete(key);
  }

  has({ repoDir, epicRef }: { repoDir: string; epicRef: number }): boolean {
    return this.roots.has(this.key(repoDir, epicRef));
  }

  private root(repoDir: string, epicRef: number, epicTitle?: string): Operation {
    const key = this.key(repoDir, epicRef);
    const current = this.roots.get(key);
    if (current) return current;
    const root = startOperation({
      type: 'epic',
      attributes: { 'epic.ref': epicRef, 'epic.repo_dir': repoDir, ...(epicTitle === undefined ? {} : { 'epic.title': epicTitle }) },
    });
    this.roots.set(key, root);
    return root;
  }

  private key(repoDir: string, epicRef: number): string {
    return `${repoDir}:${epicRef}`;
  }
}
