// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { harnessRows } from '../web/src/components/harness-table-model.js';
import { SUBSCRIPTION_COLUMNS, channelSubtitle } from '../web/src/components/channel-events-model.js';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';

vi.mock('../web/src/api.js', () => ({ api: { deleteChannel: vi.fn(), createChannel: vi.fn() } }));
const { HarnessesSection } = await import('../web/src/components/HarnessSettings.js');
const { ChannelsSection } = await import('../web/src/components/Channels.js');

afterEach(cleanup);

const harness = (command: string, models: number) => ({ command, args: ['--acp'], env: {}, models: Array.from({ length: models }, (_, i) => ({ id: `m${i}` })), defaultModel: 'm0', cacheWarmSeconds: 300 });
const baselineConfig = () => ({ harnesses: { claude: harness('claude-code-acp', 4), codex: harness('codex-acp', 2) } }) as never as import('../web/src/types.js').AppConfig;

const channel = { id: 3, name: 'ops', type: 'slack', config: { url: 'https://hooks.test/x' }, events: ['task.escalated'] } as never;

describe('harness rows', () => {
  it('derives command, status and model count', () => {
    const config = baselineConfig();
    config.harnesses.codex!.command = '';
    const rows = harnessRows(config.harnesses);
    const claude = rows.find((r) => r.id === 'claude')!;
    expect(claude.status).toBe('ready');
    expect(claude.modelCount).toBe(4);
    expect(rows.find((r) => r.id === 'codex')!.statusLabel).toBe('Not configured');
  });
});

describe('channel events model', () => {
  it('maps mockup labels onto real events', () => {
    expect(SUBSCRIPTION_COLUMNS.map((c) => c.event)).toEqual(['task.escalated', 'task.done', 'task.failed', 'queue.idle']);
    expect(channelSubtitle({ ...(channel as object), type: 'email', config: { to: 'a@b.c' } } as never)).toBe('a@b.c');
  });
});

describe('HarnessesSection table', () => {
  it('lists harnesses and Edit opens the existing editor', async () => {
    const host = await mountComponent(createElement(HarnessesSection, { config: baselineConfig(), baseline: baselineConfig(), fieldErrors: {}, permissionModes: {}, onChange: () => {} }));
    expect([...host.querySelectorAll('th')].map((t) => t.textContent)).toContain('Models');
    expect(host.querySelector('#harness-editor-claude')).toBeNull();
    const edit = [...host.querySelectorAll('tbody button')].find((b) => b.textContent === 'Edit') as HTMLElement;
    edit.click();
    await flush();
    expect((host.querySelector('#harness-editor-claude') as HTMLDetailsElement).open).toBe(true);
    expect(host.querySelectorAll('details')).toHaveLength(1);
    (host.querySelector('tbody button') as HTMLElement).click();
    await flush();
    expect(host.querySelector('#harness-editor-claude')).toBeNull();
  });

  it('opens the editor of a harness with field errors', async () => {
    const host = await mountComponent(
      createElement(HarnessesSection, { config: baselineConfig(), baseline: baselineConfig(), fieldErrors: { 'harnesses.claude.command': 'Required' }, permissionModes: {}, onChange: () => {} }),
    );
    expect((host.querySelector('#harness-editor-claude') as HTMLDetailsElement).open).toBe(true);
    expect([...host.querySelectorAll('tbody tr')][0]!.querySelector('button')).toBeNull();
  });
});

describe('ChannelsSection grid', () => {
  it('toggles the mapped event and reflects subscriptions', async () => {
    const onToggleEvent = vi.fn();
    const host = await mountComponent(createElement(ChannelsSection, { channels: [channel], onToggleEvent, onCreated: vi.fn(), onDeleted: vi.fn() }));
    const esc = host.querySelector('input[aria-label="ops Escalation"]') as HTMLInputElement;
    const merged = host.querySelector('input[aria-label="ops Merged"]') as HTMLInputElement;
    expect(esc.checked).toBe(true);
    expect(merged.checked).toBe(false);
    merged.click();
    expect(onToggleEvent).toHaveBeenCalledWith(3, 'task.done');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === '+ Add channel')).toBe(true);
  });
});
