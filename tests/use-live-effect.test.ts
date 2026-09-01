// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useLiveEffect } from '../web/src/useLiveEffect.js';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(node: ReturnType<typeof createElement>): Promise<void> {
  host = document.body.appendChild(document.createElement('div'));
  root = createRoot(host);
  return act(async () => {
    root?.render(node);
  });
}

describe('useLiveEffect', () => {
  it('reports live() true while mounted, false after teardown, and runs cleanup', async () => {
    let liveProbe: (() => boolean) | null = null;
    let cleaned = false;

    function Probe() {
      useLiveEffect((live) => {
        liveProbe = live;
        return () => {
          cleaned = true;
        };
      }, []);
      return null;
    }

    await mount(createElement(Probe));
    expect(liveProbe).not.toBeNull();
    expect(liveProbe!()).toBe(true);

    await act(async () => root?.unmount());
    expect(liveProbe!()).toBe(false);
    expect(cleaned).toBe(true);
  });

  it('skips a state update whose promise resolves after unmount', async () => {
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((r) => {
      resolve = r;
    });
    const renders: string[] = [];

    function Probe() {
      const [value, setValue] = useState('init');
      renders.push(value);
      useLiveEffect((live) => {
        void pending.then((x) => {
          if (live()) setValue(x);
        });
      }, []);
      return null;
    }

    await mount(createElement(Probe));
    await act(async () => root?.unmount());
    await act(async () => {
      resolve('loaded');
      await pending;
    });

    expect(renders).toEqual(['init']);
  });
});
