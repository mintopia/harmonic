// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionWarmthChip } from '../web/src/components/SessionWarmthChip.js';
import type { ContinuationPreview } from '../web/src/types.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

function preview(warm = true): ContinuationPreview {
  return {
    available: true,
    recommended: warm ? 'continue' : 'fresh',
    reason: warm ? 'continued-within-limits' : 'session-cold',
    contextTokens: 100,
    contextReuseTokenLimit: 200_000,
    continueFull: {
      session: 'same',
      conversation: 'full',
      estimate: {
        band: warm ? 'warm' : 'cold', warm, warmthKnown: true,
        estimatedWarmUntil: warm ? Date.now() + 5_000 : Date.now() - 5_000,
        msSinceActive: 0, msUntilCold: warm ? 5_000 : -5_000,
        note: warm ? 'Warm cache — lower cost.' : 'Cold cache — higher cost.',
      },
    },
    startCondensed: {
      session: 'new', conversation: 'condensed',
      estimate: { band: 'warm', note: 'Fresh condensed context — lower cost.' },
    },
  };
}

async function render(offered: ContinuationPreview = preview()) {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(offered)));
  return mountComponent(createElement(SessionWarmthChip, { taskId: 42 }));
}

describe('SessionWarmthChip', () => {
  it('shows the warm countdown while the cache is still warm', async () => {
    const rendered = await render(preview());
    expect(rendered.textContent).toMatch(/Warm 0:0[1-5]/);
  });

  it('shows a cold signal once the cache has lapsed', async () => {
    const rendered = await render(preview(false));
    expect(rendered.textContent).toContain('Cache cold');
  });

  it('renders nothing when no Session can resume', async () => {
    const rendered = await render({ available: false });
    expect(rendered.textContent).toBe('');
  });
});
