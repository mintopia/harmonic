/// <reference lib="dom" />
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as ui from '../web/src/ui.js';
import type { TaskState } from '../web/src/types.js';

// The jsdom environment rewrites `import.meta.url` to an http URL, so resolve
// the stylesheet from the vitest root (the repo root) instead.
const CSS = readFileSync(join(process.cwd(), 'web/src/index.css'), 'utf8');

function tokenNames(selector: RegExp): Set<string> {
  const m = selector.exec(CSS);
  if (!m) throw new Error(`token block not found: ${selector}`);
  let depth = 0;
  let i = m.index + m[0].length - 1;
  const bodyStart = i + 1;
  for (; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}' && --depth === 0) break;
  }
  const names = new Set<string>();
  for (const [, name] of CSS.slice(bodyStart, i).matchAll(/--hm-([\w-]+):/g)) {
    if (name) names.add(name);
  }
  return names;
}

const lightTokens = tokenNames(/:root\s*\{/);
const darkTokens = tokenNames(/:root\[data-theme='dark'\]\s*\{/);

const STATES = ['draft', 'ready', 'working', 'paused', 'escalated', 'done', 'cancelled'] as const satisfies readonly TaskState[];

const ATTEMPT_TONES = ['passed', 'failed', 'running'] as const;
const PILL_STATES = [...STATES, ...ATTEMPT_TONES];

const HELPERS: Record<string, () => readonly string[]> = {
  stateChip: () => STATES.map(ui.stateChip),
  statePill: () => [...PILL_STATES.map(ui.statePill), ui.statePill('implementation')],
  mergeStatusPill: () => (['merging', 'resolving-conflicts'] as const).map(ui.mergeStatusPill),
  blockerBadge: () => [ui.blockerBadge(false), ui.blockerBadge(true)],
  blockerCountPip: () => [ui.blockerCountPip(false), ui.blockerCountPip(true)],
  stateDot: () => STATES.map(ui.stateDot),
  stateFill: () => STATES.map(ui.stateFill),
  laneBorder: () => STATES.map(ui.laneBorder),
  laneDot: () => STATES.map(ui.laneDot),
  stateCountColor: () => STATES.flatMap((s) => [ui.stateCountColor(s, 0), ui.stateCountColor(s, 3)]),
  stateCountPill: () => STATES.flatMap((s) => [ui.stateCountPill(s, 0), ui.stateCountPill(s, 3)]),
  conversationStateChip: () => (['active', 'ended'] as const).map(ui.conversationStateChip),
  continuationCostChip: () => (['warm', 'cold', 'unknown'] as const).map(ui.continuationCostChip),
  permissionOptionButtonClass: () =>
    (['allow_once', 'allow_always', 'reject_once', 'reject_always'] as const).map(
      ui.permissionOptionButtonClass,
    ),
};

type Entry = { readonly name: string; readonly cls: string };

const catalogue: Entry[] = [];
for (const [name, value] of Object.entries(ui)) {
  if (typeof value === 'string') {
    catalogue.push({ name, cls: value });
  } else if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === 'string') catalogue.push({ name: `${name}.${key}`, cls: v });
    }
  }
}
for (const [name, drive] of Object.entries(HELPERS)) {
  drive().forEach((cls, i) => catalogue.push({ name: `${name}()#${i}`, cls }));
}

const COLOUR_UTIL =
  /^(?:bg|text|border|ring|from|via|to|divide|fill|stroke|outline|placeholder|shadow)-(.+)$/;

function colourTokensOf(cls: string): string[] {
  const out: string[] = [];
  for (const raw of cls.split(/\s+/)) {
    if (!raw) continue;
    const util = raw.slice(raw.lastIndexOf(':') + 1);
    const base = util.split('/')[0] ?? util;
    const m = COLOUR_UTIL.exec(base);
    if (!m || !m[1]) continue;
    const token = m[1];
    if (lightTokens.has(token) || darkTokens.has(token)) out.push(token);
  }
  return out;
}

function cssVarsOf(cls: string): string[] {
  return [...cls.matchAll(/var\(--hm-([\w-]+)\)/g)].map(([, name]) => name!).filter(Boolean);
}

describe('ui.ts primitives (issue #180)', () => {
  it('reserves the indigo await tokens for escalated — the one state that needs the operator', () => {
    expect(ui.STATE_CHIP_STYLES.escalated).toBe('bg-await-tint text-await');
    expect(ui.laneBorder('escalated')).toBe('border-await');
    expect(ui.laneDot('escalated')).toBe('bg-await-dot');
    for (const state of STATES) {
      if (state !== 'escalated') expect(ui.STATE_CHIP_STYLES[state]).not.toContain('await');
    }
  });

  it('keeps working on the running amber and done on the merged emerald', () => {
    expect(ui.STATE_CHIP_STYLES.working).toBe('bg-running-tint text-running');
    expect(ui.STATE_CHIP_STYLES.done).toBe('bg-merged text-on-done');
  });

  it('makes completed work visually distinct from ready work', () => {
    expect(ui.STATE_CHIP_STYLES.ready).toBe('bg-ready-tint text-ready');
    expect(ui.STATE_CHIP_STYLES.done).toBe('bg-merged text-on-done');
  });

  it('every --hm-* token is defined in both themes', () => {
    expect([...lightTokens].sort()).toEqual([...darkTokens].sort());
  });

  it('STATE_CHIP_STYLES is the Task states plus the attempt-only tones (issue #454)', () => {
    expect(Object.keys(ui.STATE_CHIP_STYLES).sort()).toEqual([...PILL_STATES].sort());
    for (const state of STATES) expect(ui.STATE_CHIP_STYLES[state]).toBeDefined();
  });

  it('every exported helper is exercised by the catalogue', () => {
    const exportedFns = Object.entries(ui)
      .filter(([, v]) => typeof v === 'function')
      .map(([name]) => name)
      .sort();
    expect(Object.keys(HELPERS).sort()).toEqual(exportedFns);
  });

  it('the catalogue is non-empty and every entry is a non-blank class string', () => {
    expect(catalogue.length).toBeGreaterThan(20);
    for (const { name, cls } of catalogue) {
      expect(cls.trim(), name).not.toBe('');
    }
  });

  it('every colour a primitive uses is defined in both themes', () => {
    for (const { name, cls } of catalogue) {
      for (const token of [...colourTokensOf(cls), ...cssVarsOf(cls)]) {
        expect(lightTokens, `${name}: --hm-${token} missing in light`).toContain(token);
        expect(darkTokens, `${name}: --hm-${token} missing in dark`).toContain(token);
      }
    }
  });

  describe('smoke render in both themes', () => {
    const root = document.documentElement;
    afterEach(() => root.removeAttribute('data-theme'));

    for (const theme of ['light', 'dark'] as const) {
      it(`mounts every primitive under data-theme='${theme}'`, () => {
        root.setAttribute('data-theme', theme);
        for (const { name, cls } of catalogue) {
          const el = document.createElement('div');
          el.className = cls;
          document.body.appendChild(el);
          expect(el.isConnected, name).toBe(true);
          expect(el.className, name).toBe(cls);
          el.remove();
        }
        expect(root.getAttribute('data-theme')).toBe(theme);
      });
    }
  });
});
