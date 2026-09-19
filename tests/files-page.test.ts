// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesPage } from '../web/src/components/FilesPage.js';
import { makeWorkspace } from './component-smoke-harness.js';

const { workspaceFile, workspaceFiles, gitStatus } = vi.hoisted(() => ({
  workspaceFile: vi.fn(),
  workspaceFiles: vi.fn().mockResolvedValue({ path: '', entries: [], total: 0, limit: 100, offset: 0 }),
  gitStatus: vi.fn().mockResolvedValue({ entries: [] }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('../web/src/api.js', () => ({
  api: {
    workspaceFiles,
    gitStatus,
    workspaceFile,
    workspaceRawUrl: (workspaceId: number, path: string) => `/api/fs/raw?workspaceId=${workspaceId}&path=${encodeURIComponent(path)}`,
  },
}));

vi.mock('../web/src/components/CodeViewer.js', () => ({ CodeViewer: () => createElement('div', { 'aria-label': 'Code editor' }) }));
vi.mock('../web/src/components/Markdown.js', () => ({ Markdown: ({ source }: { source: string }) => createElement('div', { 'data-testid': 'markdown-preview' }, source) }));

describe('FilesPage previews (issue #588)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;
  const workspace = makeWorkspace();

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.clearAllMocks();
  });

  async function render(path: string) {
    host ??= document.body.appendChild(document.createElement('div'));
    root ??= createRoot(host);
    await act(async () => {
      root?.render(createElement(FilesPage, { workspace, selectedPath: path, onSelectFile: () => {}, onWorkspaceSaved: () => {} }));
      await Promise.resolve();
    });
  }

  it('opens media in tabs and offers downloads for binary and oversized files', async () => {
    workspaceFile.mockImplementation((_workspaceId: number, path: string) => Promise.resolve({
      image: { text: null, mime: 'image/png', size: 4, isBinary: true, isTooLarge: false },
      audio: { text: null, mime: 'audio/mpeg', size: 3, isBinary: true, isTooLarge: false },
      binary: { text: null, mime: 'application/octet-stream', size: 1, isBinary: true, isTooLarge: false },
      large: { text: null, mime: 'text/plain', size: 2_097_153, isBinary: false, isTooLarge: true },
    }[path]));

    await render('image');
    expect(host?.querySelector('img')?.getAttribute('src')).toContain('path=image');
    await render('audio');
    expect(host?.querySelector('audio')?.getAttribute('src')).toContain('path=audio');
    await render('binary');
    expect(host?.querySelector('a')?.hasAttribute('download')).toBe(true);
    await render('large');
    expect(host?.textContent).toContain('too large to edit');
    expect(Array.from(host?.querySelectorAll('button') ?? []).map((button) => button.textContent)).toEqual(expect.arrayContaining(['image', 'audio', 'binary', 'large']));
  });

  it('renders Markdown preview instead of an editable code view', async () => {
    workspaceFile.mockResolvedValue({ text: '# Notes', mime: 'text/markdown', size: 7, isBinary: false, isTooLarge: false });
    await render('notes.markdown');
    const preview = host?.querySelector('[aria-label="Preview"]');
    await act(async () => preview?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(host?.querySelector('[data-testid="markdown-preview"]')?.textContent).toBe('# Notes');
    expect(host?.querySelector('[aria-label="Code editor"]')).toBeNull();
  });

  it('shows files in the tree and swaps the sidebar to Source Control', async () => {
    workspaceFiles.mockResolvedValue({ path: '', entries: [
      { name: 'src', path: 'src', type: 'directory', size: 0, excluded: false },
      { name: 'README.md', path: 'README.md', type: 'file', size: 12, excluded: false },
    ], total: 2, limit: 100, offset: 0 });
    gitStatus.mockResolvedValue({ entries: [{ path: 'README.md', indexStatus: '.', worktreeStatus: 'M' }] });

    host ??= document.body.appendChild(document.createElement('div'));
    root ??= createRoot(host);
    await act(async () => {
      root?.render(createElement(FilesPage, { workspace, selectedPath: null, onSelectFile: () => {}, onWorkspaceSaved: () => {} }));
      await Promise.resolve();
    });

    const treeNodes = Array.from(host.querySelectorAll('[role="treeitem"]'));
    const treeItems = treeNodes.map((node) => node.textContent);
    expect(treeItems).toEqual(expect.arrayContaining([expect.stringContaining('README.md'), expect.stringContaining('src')]));
    // Roving tabindex: exactly one tree item is tabbable, the rest are -1 (WAI-ARIA tree).
    expect(treeNodes.filter((node) => node.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(treeNodes.every((node) => node.hasAttribute('data-treepath'))).toBe(true);
    expect(host.querySelector('#commit-message')).toBeNull();

    const scmButton = host.querySelector('[aria-label="Source control"]');
    await act(async () => scmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(host.querySelector('#commit-message')).not.toBeNull();
    expect(host.querySelector('[role="treeitem"]')).toBeNull();
  });

  it('surfaces a git-status fetch failure in the Source Control panel (issue #653)', async () => {
    workspaceFiles.mockResolvedValue({ path: '', entries: [], total: 0, limit: 100, offset: 0 });
    gitStatus.mockRejectedValueOnce(new Error('git status failed'));

    host ??= document.body.appendChild(document.createElement('div'));
    root ??= createRoot(host);
    await act(async () => {
      root?.render(createElement(FilesPage, { workspace, selectedPath: null, onSelectFile: () => {}, onWorkspaceSaved: () => {} }));
      await Promise.resolve();
    });

    const scmButton = host.querySelector('[aria-label="Source control"]');
    await act(async () => scmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(host.textContent).toContain('git status failed');
    expect(host.textContent).not.toContain('The working tree is clean.');
  });
});
