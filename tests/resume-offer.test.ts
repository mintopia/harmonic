// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResumeOffer } from '../web/src/components/ResumeOffer.js';
import type { ContinuationPreview } from '../web/src/types.js';
import { cleanup, mountComponent } from './component-smoke-harness.js';

let host: HTMLDivElement | null = null;

afterEach(cleanup);

function preview(warm = true): ContinuationPreview {
  return {
    available: true,
    continueFull: {
      session: 'same',
      conversation: 'full',
      estimate: {
        band: warm ? 'warm' : 'cold', warm, warmthKnown: true,
        estimatedWarmUntil: Date.now() + 5_000, msSinceActive: 0, msUntilCold: 5_000,
        note: warm ? 'Warm cache — lower cost.' : 'Cold cache — higher cost.',
      },
    },
    startCondensed: {
      session: 'new', conversation: 'condensed',
      estimate: { band: 'warm', note: 'Fresh condensed context — lower cost.' },
    },
  };
}

async function render({ compact = false, offered = preview() }: { compact?: boolean; offered?: ContinuationPreview } = {}) {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(offered)));
  host = await mountComponent(createElement(ResumeOffer, { taskId: 42, compact }));
  return host;
}

describe('ResumeOffer (issue #507)', () => {
  it('shows both priced paths, selecting the warm full continuation and its live warmth countdown', async () => {
    const rendered = await render();
    expect(rendered.textContent).toContain('Continue full session');
    expect(rendered.textContent).toContain('Start condensed session');
    expect(rendered.textContent).toContain('Warm cache — lower cost.');
    expect(rendered.textContent).toContain('Fresh condensed context — lower cost.');
    expect(rendered.textContent).toContain('Estimated warm time');
    expect(rendered.textContent).toContain('Estimated warm cost');
    expect(rendered.textContent).toContain('Recommended');
  });

  it('switches the deterministic recommendation to condensed once the full continuation is cold', async () => {
    const rendered = await render({ offered: preview(false) });
    expect(rendered.querySelector('.ring-accent')?.textContent).toContain('Start condensed session');
    expect(rendered.textContent).toContain('Estimated cold cost');
    expect(rendered.textContent).toContain('Continue full session');
  });

  it('shows the warmth countdown in the compact card chip', async () => {
    const rendered = await render({ compact: true, offered: preview() });
    expect(rendered.textContent).toMatch(/Likely warm 0:0[1-5]/);
  });

  it('renders no resume or countdown UI when no Session can resume', async () => {
    const rendered = await render({ offered: { available: false } });
    expect(rendered.textContent).toBe('');
  });
});
