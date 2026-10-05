// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Properties } from '../web/src/components/ticket/Metrics.js';
import type { Task } from '../web/src/types.js';
import { task as storyTask } from '../web/src/story/fixtures.js';
import { trackerRef } from '../src/tracker/adapter.js';
import { cleanup, makeTask, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

const mount = (task: Task) => mountComponent(createElement(Properties, { task, allTasks: [task], workspaceName: 'ws' }));

describe('Properties tracker fact', () => {
  it('links the ref to the issue URL for a mirrored Task with a URL', async () => {
    const host = await mount(makeTask({ origin: 'mirrored', trackerRef: trackerRef(798), trackerLabel: 'GitHub', url: 'https://github.com/o/r/issues/798' }));
    const link = host.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://github.com/o/r/issues/798');
    expect(link?.textContent).toContain('GitHub');
    expect(link?.textContent).toContain('#798');
  });

  it('shows the tracker name without a link when there is no URL', async () => {
    const host = await mount(makeTask({ origin: 'mirrored', trackerRef: trackerRef(3), trackerLabel: 'Local markdown', url: null }));
    expect(host.querySelector('a')).toBeNull();
    expect(host.textContent).toContain('Local markdown');
  });

  it('renders GitHub #<n> as a link for the story ticket fixture', async () => {
    const host = await mount(storyTask as Task);
    const link = host.querySelector('a');
    expect(link?.textContent?.replace(/\s+/g, ' ').trim()).toBe(`GitHub #${storyTask.trackerRef}`);
    expect(link?.getAttribute('href')).toBe(storyTask.url);
  });

  it('shows nothing for a native Task', async () => {
    const host = await mount(makeTask());
    expect(host.textContent).not.toContain('Tracker');
  });
});
