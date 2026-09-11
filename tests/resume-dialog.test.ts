// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResumeDialog } from '../web/src/components/ResumeDialog.js';
import type { ContinuationPreview } from '../web/src/types.js';
import { cleanup, flush, mountComponent } from './component-smoke-harness.js';

afterEach(cleanup);

function preview(warm = true): Extract<ContinuationPreview, { available: true }> {
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
      estimate: { band: warm ? 'cold' : 'warm', note: 'Fresh condensed context.' },
    },
  };
}

async function render(offered: ContinuationPreview) {
  const resume = vi.fn(async () => {});
  const onDone = vi.fn();
  const host = await mountComponent(
    createElement(ResumeDialog, {
      taskId: 42,
      onClose: () => {},
      onDone,
      resume,
      loadPreview: async () => offered,
    }),
  );
  return { host, resume, onDone };
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    await flush();
  });
}

describe('ResumeDialog', () => {
  it('offers both paths, preselects the recommended continue on a warm session, and shows the countdown', async () => {
    const { host } = await render(preview());
    expect(host.textContent).toContain('Continue session');
    expect(host.textContent).toContain('Start fresh session');
    expect(host.textContent).toContain('Warm cache · low cost');
    expect(host.textContent).toContain('Warm for');
    const selected = host.querySelector('[role="radio"][aria-checked="true"]');
    expect(selected?.textContent).toContain('Continue session');
  });

  it('resumes with the full conversation when continue is chosen', async () => {
    const { host, resume, onDone } = await render(preview());
    await click(button(host, 'Resume'));
    expect(resume).toHaveBeenCalledWith('full');
    expect(onDone).toHaveBeenCalled();
  });

  it('preselects fresh on a cold session, states why, and resumes condensed', async () => {
    const { host, resume } = await render(preview(false));
    expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain('Start fresh session');
    expect(host.textContent).toContain('gone cold');
    await click(button(host, 'Resume'));
    expect(resume).toHaveBeenCalledWith('condensed');
  });

  it('honors an override away from the recommendation', async () => {
    const { host, resume } = await render(preview());
    const fresh = [...host.querySelectorAll('[role="radio"]')].find((r) =>
      r.textContent?.includes('Start fresh session'),
    ) as HTMLElement;
    await click(fresh);
    await click(button(host, 'Resume'));
    expect(resume).toHaveBeenCalledWith('condensed');
  });

  it('resumes plainly with no choice when no Session can be reused', async () => {
    const { host, resume } = await render({ available: false });
    expect(host.textContent).toContain('no prior session to reuse');
    expect(host.querySelector('[role="radio"]')).toBeNull();
    await click(button(host, 'Resume'));
    expect(resume).toHaveBeenCalledWith(undefined);
  });
});
