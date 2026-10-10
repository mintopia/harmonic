import { lstatSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { WorkspaceRow } from '../db/schema.js';
import { logger } from '../logger.js';
import { forEachYielding } from '../reliability/yield.js';
import { readGitStatus, type GitStatusEntry } from './git-status.js';

export interface WorkspaceWatcherEvents {
  fsChanged(workspaceId: number): void;
  gitStatus(workspaceId: number, entries: GitStatusEntry[]): void;
}

type WatchedWorkspace = {
  watchers: Map<string, FSWatcher>;
  signature: string;
  timer: ReturnType<typeof setTimeout> | null;
  fsChanged: boolean;
  gitChanged: boolean;
  degraded: boolean;
  stopped: boolean;
};

function isWatchExhausted(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOSPC' || code === 'EMFILE';
}

function newState(signature: string): WatchedWorkspace {
  return { watchers: new Map(), signature, timer: null, fsChanged: false, gitChanged: false, degraded: false, stopped: false };
}

function gitMetadataPaths(root: string): string[] {
  const dotGit = resolve(root, '.git');
  try {
    if (!statSync(dotGit).isFile()) return [resolve(dotGit, 'index'), resolve(dotGit, 'HEAD')];
    const target = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)\s*$/m)?.[1];
    if (target) return [resolve(root, target, 'index'), resolve(root, target, 'HEAD')];
  } catch {
  }
  return [resolve(dotGit, 'index'), resolve(dotGit, 'HEAD')];
}

/** Watches the user-visible portion of every Workspace and sends one update per change burst. */
export class WorkspaceWatcher {
  private readonly watched = new Map<number, WatchedWorkspace>();

  constructor(
    private readonly debounceMs: () => number,
    private readonly events: WorkspaceWatcherEvents,
  ) {}

  async sync(workspaces: readonly WorkspaceRow[]): Promise<void> {
    const wanted = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    await Promise.all([...this.watched].filter(([id]) => !wanted.has(id)).map(([id]) => this.stop(id)));
    await Promise.all(workspaces.map(async (workspace) => {
      const signature = JSON.stringify([resolve(workspace.workingDir), [...workspace.excludedDirectories].sort()]);
      if (this.watched.get(workspace.id)?.signature === signature) return;
      await this.stop(workspace.id);
      await this.start(workspace, signature);
    }));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.watched.keys()].map((id) => this.stop(id)));
  }

  /** Number of active directory watches for a Workspace (0 when unwatched). */
  watchCount(workspaceId: number): number {
    return this.watched.get(workspaceId)?.watchers.size ?? 0;
  }

  isDegraded(workspaceId: number): boolean {
    return this.watched.get(workspaceId)?.degraded ?? false;
  }

  private async start(workspace: WorkspaceRow, signature: string): Promise<void> {
    const root = resolve(workspace.workingDir);
    const state = newState(signature);
    this.watched.set(workspace.id, state);
    if (dirname(root) === root) {
      logger.warn('workspace watcher skipped: refusing to watch a filesystem root', { workspaceId: workspace.id, root });
      return;
    }
    const excluded = new Set(workspace.excludedDirectories.map((path) => resolve(root, path)));
    const isIgnored = (path: string): boolean => {
      const resolved = resolve(path);
      return [...excluded].some((directory) => resolved === directory || resolved.startsWith(`${directory}${sep}`));
    };
    const gitPaths = gitMetadataPaths(root);
    const isGitPath = (path: string): boolean => {
      const resolved = resolve(path);
      return gitPaths.includes(resolved) || ['.git/index', '.git/HEAD'].includes(relative(root, resolved).split(sep).join('/'));
    };

    const unwatch = (dir: string): void => {
      for (const [watched, watcher] of [...state.watchers]) {
        if (watched !== dir && !watched.startsWith(`${dir}${sep}`)) continue;
        watcher.close();
        state.watchers.delete(watched);
      }
    };

    const addWatch = (dir: string): boolean => {
      if (state.stopped || state.degraded) return false;
      if (state.watchers.has(dir)) return true;
      try {
        const watcher = watch(dir, { persistent: true, recursive: false }, (_event, filename) => onEvent(dir, filename === null ? null : String(filename)));
        watcher.on('error', (err) => {
          if (state.watchers.get(dir) === watcher) state.watchers.delete(dir);
          watcher.close();
          if (isWatchExhausted(err)) markDegraded(err);
          else logger.warn('workspace watcher error', { workspaceId: workspace.id, root, dir, error: err instanceof Error ? err.message : String(err) });
        });
        state.watchers.set(dir, watcher);
        return true;
      } catch (err) {
        if (isWatchExhausted(err)) markDegraded(err);
        else if ((err as NodeJS.ErrnoException).code !== 'ENOENT' && (err as NodeJS.ErrnoException).code !== 'ENOTDIR') {
          logger.warn('workspace watcher error', { workspaceId: workspace.id, root, dir, error: err instanceof Error ? err.message : String(err) });
        }
        return false;
      }
    };

    const markDegraded = (err: unknown): void => {
      if (state.degraded) return;
      state.degraded = true;
      logger.warn('workspace watcher degraded: out of file watches, new directories will not be watched', {
        workspaceId: workspace.id,
        root,
        watches: state.watchers.size,
        error: err instanceof Error ? err.message : String(err),
      });
    };

    const walk = async (start: string): Promise<void> => {
      const pending = [start];
      await forEachYielding(pending, async (dir) => {
        if (state.stopped || state.degraded || isIgnored(dir) || !addWatch(dir)) return;
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          unwatch(dir);
          return;
        }
        for (const entry of entries) {
          if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(join(dir, entry.name));
        }
      });
    };

    const onEvent = (dir: string, filename: string | null): void => {
      if (state.stopped) return;
      const path = filename === null ? dir : join(dir, filename);
      if (!isGitPath(path) && relative(root, path).startsWith('..')) return;
      if (isGitPath(path)) state.gitChanged = true;
      else if (!isIgnored(path)) state.fsChanged = true;
      else return;
      this.schedule(workspace.id, workspace.workingDir, state);
      if (filename === null || isGitPath(path) || isIgnored(path)) return;
      let isDirectory = false;
      try {
        isDirectory = lstatSync(path).isDirectory();
      } catch {
        unwatch(path);
        return;
      }
      if (isDirectory && !state.watchers.has(path)) {
        void walk(path).catch((err) => logger.warn('workspace watcher walk failed', { workspaceId: workspace.id, path, error: err instanceof Error ? err.message : String(err) }));
      }
    };

    for (const gitDir of new Set(gitPaths.map((path) => dirname(path)))) addWatch(gitDir);
    await walk(root);
  }

  private schedule(workspaceId: number, root: string, state: WatchedWorkspace): void {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.timer = null;
      const fsChanged = state.fsChanged;
      const gitChanged = state.gitChanged || fsChanged;
      state.fsChanged = false;
      state.gitChanged = false;
      if (fsChanged) this.events.fsChanged(workspaceId);
      if (gitChanged) void readGitStatus(root).then((status) => this.events.gitStatus(workspaceId, status.entries)).catch((err) => logger.warn('workspace git status refresh failed', { workspaceId, error: err instanceof Error ? err.message : String(err) }));
    }, this.debounceMs());
  }

  private async stop(id: number): Promise<void> {
    const state = this.watched.get(id);
    if (!state) return;
    this.watched.delete(id);
    if (state.timer !== null) clearTimeout(state.timer);
    state.stopped = true;
    for (const watcher of state.watchers.values()) watcher.close();
    state.watchers.clear();
  }
}
