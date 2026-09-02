// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { VerificationEscalationCard } from '../web/src/components/VerificationEscalationCard.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function renderCard() {
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  await act(async () => {
    root?.render(
      createElement(VerificationEscalationCard, {
        verdicts: { critic: { pass: 4, block: 1, inconclusive: 0 } },
        gateOutcomes: { autoMerged: 3, escalated: 1, revertedOnRed: 1 },
        guardrailTrips: { costUsd: 2, wallClockMinutes: 0 },
      }),
    );
  });
  return host;
}

describe('VerificationEscalationCard accessibility (issue #472)', () => {
  it('drops the fake role="table" and renders real <dl> description lists', async () => {
    const el = await renderCard();

    expect(el.querySelector('[role="table"]')).toBeNull();

    const dls = [...el.querySelectorAll('dl')];
    expect(dls.length).toBeGreaterThan(0);

    for (const dl of dls) {
      const dts = dl.querySelectorAll('dt');
      const dds = dl.querySelectorAll('dd');
      expect(dts.length).toBeGreaterThan(0);
      expect(dds.length).toBeGreaterThan(0);
      expect(dts.length).toBe(dds.length);
    }
  });
});
