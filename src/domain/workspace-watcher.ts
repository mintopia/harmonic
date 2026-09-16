import chokidar, { type FSWatcher } from 'chokidar';
import { readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import type { WorkspaceRow } from '../db/schema.js';
import { logger } from '../logger.js';
import { readGitStatus, type GitStatusEntry } from './git-status.js';

export interface WorkspaceWatcherEvents {
  fsChanged(workspaceId: number): void;
  gitStatus(workspaceId: number, entries: GitStatusEntry[]): void;
}

type WatchedWorkspace = { watcher: FSWatcher | null; signature: string; timer: ReturnType<typeof setTimeout> | null; fsChanged: boolean; gitChanged: boolean };

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

  private async start(workspace: WorkspaceRow, signature: string): Promise<void> {
    const root = resolve(workspace.workingDir);
    if (dirname(root) === root) {
      logger.warn('workspace watcher skipped: refusing to watch a filesystem root', { workspaceId: workspace.id, root });
      this.watched.set(workspace.id, { watcher: null, signature, timer: null, fsChanged: false, gitChanged: false });
      return;
    }
    const excluded = new Set(workspace.excludedDirectories.map((path) => resolve(root, path)));
    const isIgnored = (path: string): boolean => {
      const resolved = resolve(path);
      return [...excluded].some((directory) => resolved === directory || resolved.startsWith(`${directory}${sep}`));
    };
    const gitPaths = gitMetadataPaths(root);
    const watcher = chokidar.watch([root, ...gitPaths], {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (path) => isIgnored(path) && !path.endsWith(`${sep}.git${sep}index`) && !path.endsWith(`${sep}.git${sep}HEAD`),
    });
    const state: WatchedWorkspace = { watcher, signature, timer: null, fsChanged: false, gitChanged: false };
    this.watched.set(workspace.id, state);
    watcher.on('error', (err) => {
      logger.warn('workspace watcher error', { workspaceId: workspace.id, root, error: err instanceof Error ? err.message : String(err) });
    });
    watcher.on('all', (_event, path) => {
      const relativePath = relative(root, path).split(sep).join('/');
      if (gitPaths.some((gitPath) => resolve(path) === gitPath) || relativePath === '.git/index' || relativePath === '.git/HEAD') state.gitChanged = true;
      else if (!isIgnored(path)) state.fsChanged = true;
      else return;
      this.schedule(workspace.id, workspace.workingDir, state);
    });
    await new Promise<void>((ready) => {
      watcher.once('ready', () => ready());
      watcher.once('error', () => ready());
    });
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
    if (state.watcher) await state.watcher.close();
  }
}
