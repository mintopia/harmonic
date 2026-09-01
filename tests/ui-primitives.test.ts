/// <reference lib="dom" />
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as ui from '../web/src/ui.js';
import type { TaskState } from '../web/src/types.js';

/**
 * Storybook-less smoke render of every Deck primitive in `web/src/ui.ts`, in
 * both themes (issue #180 acceptance).
 *
 * `ui.ts` is the shared component vocabulary expressed as Tailwind class
 * strings, so there is nothing to import into a component library. This test
 * proves, without one, that:
 *   1. every exported primitive mounts onto a real element (jsdom) under a
 *      light-themed AND a dark-themed root without throwing — the smoke render;
 *   2. every colour utility a primitive uses resolves to a `--hm-*` token that
 *      is defined in BOTH themes, so a primitive can never reference a colour
 *      only one theme carries — the "in both themes" guarantee that a jsdom
 *      mount alone (no CSS engine) can't give;
 *   3. the catalogue stays honest: every exported string, style-map value, and
 *      helper function is covered, so a new primitive can't ship untested.
 *
 * It reads the same source of truth as `contrast.test.ts` — the `--hm-*` custom
 * properties in `web/src/index.css`.
 */

// The jsdom environment rewrites `import.meta.url` to an http URL, so resolve
// the stylesheet from the vitest root (the repo root) instead.
const CSS = readFileSync(join(process.cwd(), 'web/src/index.css'), 'utf8');

/** The `--hm-*` names declared in one CSS rule (brace-counted so the nested
 * media block never bleeds in — the same scan `contrast.test.ts` uses). */
function tokenNames(selector: RegExp): Set<string> {
  const m = selector.exec(CSS);
  if (!m) throw new Error(`token block not found: ${selector}`);
  let depth = 0;
  let i = m.index + m[0].length - 1; // sits on the opening `{`
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

const STATES = ['draft', 'ready', 'working', 'escalated', 'done', 'cancelled'] as const satisfies readonly TaskState[];

/** Every exported helper function, driven across its whole input domain so each
 * branch it can return is in the catalogue. Keyed by export name and asserted
 * complete below, so a newly added helper forces itself into coverage. */
const HELPERS: Record<string, () => readonly string[]> = {
  stateChip: () => STATES.map(ui.stateChip),
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

/** The full primitive catalogue, built from the module's own exports so it can't
 * drift from `ui.ts`: string exports are primitives, object exports are
 * style-maps (each value a primitive), function exports are driven by HELPERS. */
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

/** A Tailwind colour utility carries a colour token in its suffix; a sizing or
 * layout utility (`text-label`, `px-3.5`, `rounded-xl`) does not. We tell them
 * apart by the token table itself: only a suffix that names a real `--hm-*`
 * colour is asserted, so `text-label` (a font-size) and `border-transparent`
 * fall through untouched. */
const COLOUR_UTIL =
  /^(?:bg|text|border|ring|from|via|to|divide|fill|stroke|outline|placeholder|shadow)-(.+)$/;

function colourTokensOf(cls: string): string[] {
  const out: string[] = [];
  for (const raw of cls.split(/\s+/)) {
    if (!raw) continue;
    const util = raw.slice(raw.lastIndexOf(':') + 1); // drop variant prefixes (hover:, disabled:, motion-safe:)
    const base = util.split('/')[0] ?? util; // drop the opacity modifier (/50)
    const m = COLOUR_UTIL.exec(base);
    if (!m || !m[1]) continue;
    const token = m[1];
    if (lightTokens.has(token) || darkTokens.has(token)) out.push(token);
  }
  return out;
}

/** Custom-property references inside a Tailwind arbitrary value —
 * `shadow-[0_0_0_1.5px_var(--hm-accent)]` on `runChipActive`, etc. Unlike a
 * utility suffix (where `text-label` is a font-size, not a colour, so an
 * unknown suffix can't be assumed to be a token), a `var(--hm-*)` reference is
 * unambiguously meant to resolve, so a name here that isn't defined in a theme
 * is a real defect, not a false positive — this closes the hole where a typo'd
 * `var(--hm-accnet)` would render nothing and pass a CSS-engine-less smoke mount. */
function cssVarsOf(cls: string): string[] {
  return [...cls.matchAll(/var\(--hm-([\w-]+)\)/g)].map(([, name]) => name!).filter(Boolean);
}

describe('ui.ts primitives (issue #180)', () => {
  it('reserves the indigo await tokens for escalated — the one state that needs the operator (ADR-0041)', () => {
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

  it('STATES stays in lockstep with the state-keyed maps', () => {
    expect([...STATES].sort()).toEqual(Object.keys(ui.STATE_CHIP_STYLES).sort());
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
