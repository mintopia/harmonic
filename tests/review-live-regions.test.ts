// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewLiveRegions } from '../web/src/components/ReviewLiveRegions.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function renderLiveRegions(polite: string, assertive: string): Promise<HTMLDivElement> {
  host ??= document.body.appendChild(document.createElement('div'));
  root ??= createRoot(host);
  await act(async () => root?.render(createElement(ReviewLiveRegions, { polite, assertive })));
  return host;
}

describe('ReviewLiveRegions', () => {
  it('keeps polite and assertive updates in separate, stable live regions', async () => {
    const first = await renderLiveRegions('Check contrast needs you: escalated. Needs you: 1.', '');
    const polite = first.querySelector('[aria-live="polite"]');
    const assertive = first.querySelector('[aria-live="assertive"]');

    expect(polite?.getAttribute('aria-atomic')).toBe('true');
    expect(polite?.textContent).toBe('Check contrast needs you: escalated. Needs you: 1.');
    expect(assertive?.textContent).toBe('');

    const unchanged = await renderLiveRegions('Check contrast needs you: escalated. Needs you: 1.', '');
    expect(unchanged.querySelector('[aria-live="polite"]')).toBe(polite);
    expect(unchanged.querySelector('[aria-live="assertive"]')).toBe(assertive);

    const merged = await renderLiveRegions('Needs you: 0.', 'Check contrast merged.');
    expect(merged.querySelector('[aria-live="polite"]')?.textContent).toBe('Needs you: 0.');
    expect(merged.querySelector('[aria-live="assertive"]')?.textContent).toBe('Check contrast merged.');
  });
});
