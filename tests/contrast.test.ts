import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(fileURLToPath(new URL('../web/src/index.css', import.meta.url)), 'utf8');

const WHITE = '#ffffff'; // the Switch knob (`bg-white`, web/src/components/Switch.tsx)

/** Relative luminance of an sRGB hex colour (WCAG 2.1 relative-luminance def). */
function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const chan = (i: number) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * chan(0) + 0.7152 * chan(2) + 0.0722 * chan(4);
}

/** Contrast ratio between two hex colours (WCAG 2.1 contrast-ratio def). */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function tokensIn(css: string, selector: RegExp): Record<string, string> {
  const m = selector.exec(css);
  if (!m) throw new Error(`token block not found: ${selector}`);
  let depth = 0;
  let i = m.index + m[0].length - 1;
  const bodyStart = i + 1;
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) break;
  }
  const body = css.slice(bodyStart, i);
  const out: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(/--hm-([\w-]+):\s*([^;]+);/g)) {
    if (name && value) out[name] = value.trim().toLowerCase();
  }
  return out;
}

const light = tokensIn(CSS, /:root\s*\{/);
const darkExplicit = tokensIn(CSS, /:root\[data-theme='dark'\]\s*\{/);
const darkSystem = tokensIn(CSS, /:root:not\(\[data-theme='light'\]\)\s*\{/);
const themes = { light, dark: darkExplicit } as const;

function hex(tokens: Record<string, string>, name: string): string {
  const value = tokens[name];
  if (value === undefined) throw new Error(`missing token: --hm-${name}`);
  return value;
}

const TEXT_ON_TINT: ReadonlyArray<readonly [string, string, string]> = [
  ['ready', 'ready', 'ready-tint'],
  ['await', 'await', 'await-tint'],
  ['merged', 'merged', 'merged-tint'],
  ['failed', 'fail', 'fail-tint'],
  ['blocked', 'muted', 'blocked-tint'],
  ['working chip', 'running', 'running-tint'],
  ['blocked slate badge', 'blocked', 'blocked-tint'],
  ['tool', 'tool', 'tool-tint'],
  ['harness chip mark', 'tool', 'tool-tint'],
  ['accent', 'accent', 'accent-tint'],
  ['selection', 'ink', 'accent-tint'],
  ['permission-band headline', 'ink', 'running-tint'],
  ['permission-band meta', 'muted', 'running-tint'],
];

const TEXT_FLOOR = 4.5;
const UI_FLOOR = 3;
const PAPER_TOKENS = ['await', 'await-dot', 'await-tint', 'on-await', 'on-done', 'sunken', 'edge-strong'] as const;

const TOKEN_CLASS_TOKENS = ['token-input', 'token-output', 'token-cache-read', 'token-cache-write'] as const;

describe('Paper palette meets WCAG AA in both themes (issue #260)', () => {
  it('defines the same dark tokens via data-theme and prefers-color-scheme', () => {
    expect(darkSystem).toEqual(darkExplicit);
  });

  it('defines the Paper tokens in both themes and maps them to Tailwind colors', () => {
    for (const token of PAPER_TOKENS) {
      expect(light[token]).toBeDefined();
      expect(darkExplicit[token]).toBeDefined();
      expect(CSS).toContain(`--color-${token}: var(--hm-${token});`);
    }
  });

  it('defines the warm token-class ramp in both themes and maps it to Tailwind colors (ADR-0014)', () => {
    for (const token of TOKEN_CLASS_TOKENS) {
      expect(light[token]).toBeDefined();
      expect(darkExplicit[token]).toBeDefined();
      expect(CSS).toContain(`--color-${token}: var(--hm-${token});`);
    }
  });

  it('uses the merged token family, not the retired accept family', () => {
    for (const tokens of [light, darkExplicit, darkSystem]) {
      expect(tokens.accept).toBeUndefined();
      expect(tokens['accept-dot']).toBeUndefined();
      expect(tokens['accept-tint']).toBeUndefined();
      expect(tokens.merged).toBeDefined();
      expect(tokens['merged-dot']).toBeDefined();
      expect(tokens['merged-tint']).toBeDefined();
    }
    expect(CSS).not.toContain('--color-accept:');
    expect(CSS).toContain('--color-merged: var(--hm-merged);');
  });

  for (const [themeName, t] of Object.entries(themes)) {
    describe(themeName, () => {
      for (const [label, fg, bg] of TEXT_ON_TINT) {
        it(`state text-on-tint: ${label} ≥ ${TEXT_FLOOR}:1`, () => {
          expect(contrast(hex(t, fg), hex(t, bg))).toBeGreaterThanOrEqual(TEXT_FLOOR);
        });
      }

      for (const role of ['running', 'blocked'] as const) {
        for (const bg of ['surface', 'canvas', 'raised'] as const) {
          it(`${role} count/figure on ${bg} ≥ ${TEXT_FLOOR}:1`, () => {
            expect(contrast(hex(t, role), hex(t, bg))).toBeGreaterThanOrEqual(TEXT_FLOOR);
          });
        }
      }

      for (const [label, fg, bg] of [
        ['await', 'on-await', 'await'],
        ['merged', 'on-done', 'merged'],
      ] as const) {
        it(`${label} solid-fill ink ≥ ${TEXT_FLOOR}:1`, () => {
          expect(contrast(hex(t, fg), hex(t, bg))).toBeGreaterThanOrEqual(TEXT_FLOOR);
        });
      }

      for (const role of ['ink', 'muted', 'faint'] as const) {
        for (const bg of ['surface', 'canvas', 'raised', 'sunken'] as const) {
          it(`${role} on ${bg} ≥ ${TEXT_FLOOR}:1`, () => {
            expect(contrast(hex(t, role), hex(t, bg))).toBeGreaterThanOrEqual(TEXT_FLOOR);
          });
        }
      }

      it(`on-fail label on the fail fill ≥ ${TEXT_FLOOR}:1`, () => {
        expect(contrast(hex(t, 'on-fail'), hex(t, 'fail'))).toBeGreaterThanOrEqual(TEXT_FLOOR);
      });

      for (const token of TOKEN_CLASS_TOKENS) {
        it(`token class ${token} vs bar track ≥ ${UI_FLOOR}:1`, () => {
          expect(contrast(hex(t, token), hex(t, 'raised'))).toBeGreaterThanOrEqual(UI_FLOOR);
        });
      }

      it(`Switch off-track: knob vs track ≥ ${UI_FLOOR}:1`, () => {
        expect(contrast(WHITE, hex(t, 'switch-off'))).toBeGreaterThanOrEqual(UI_FLOOR);
      });
      it(`Switch off-track: track vs card ≥ ${UI_FLOOR}:1`, () => {
        expect(contrast(hex(t, 'switch-off'), hex(t, 'surface'))).toBeGreaterThanOrEqual(UI_FLOOR);
      });

      it(`neutral lane rule vs canvas ≥ ${UI_FLOOR}:1`, () => {
        expect(contrast(hex(t, 'faint'), hex(t, 'canvas'))).toBeGreaterThanOrEqual(UI_FLOOR);
      });

      for (const seam of ['hairline', 'edge'] as const) {
        it(`${seam} is a visible sub-floor seam on surface (1:1 < r < ${UI_FLOOR}:1)`, () => {
          const r = contrast(hex(t, seam), hex(t, 'surface'));
          expect(r).toBeGreaterThan(1);
          expect(r).toBeLessThan(UI_FLOOR);
        });
      }
    });
  }
});

describe('Attempt-activity heatmap ramp reads as an intensity scale (issue #405)', () => {
  const STEPS = ['heat-1', 'heat-2', 'heat-3', 'heat-4'] as const;

  for (const [themeName, t] of Object.entries(themes)) {
    describe(themeName, () => {
      it('defines the neutral empty tile and the four teal steps', () => {
        for (const token of ['heat-0', ...STEPS]) expect(t[token]).toBeDefined();
      });

      it('ramps monotonically — darker with intensity on Paper, brighter on dark', () => {
        const lums = STEPS.map((s) => luminance(hex(t, s)));
        const ordered = lums.every((l, i) => i === 0 || (themeName === 'light' ? l < lums[i - 1]! : l > lums[i - 1]!));
        expect(ordered).toBe(true);
      });

      it('keeps the empty tile a visible tile, distinct from the card and from level 1', () => {
        expect(contrast(hex(t, 'heat-0'), hex(t, 'surface'))).toBeGreaterThan(1.1);
        expect(contrast(hex(t, 'heat-0'), hex(t, 'heat-1'))).toBeGreaterThan(1.1);
      });

      it('separates the busiest step from empty as a graphical object (≥ 3:1)', () => {
        expect(contrast(hex(t, 'heat-4'), hex(t, 'heat-0'))).toBeGreaterThanOrEqual(UI_FLOOR);
      });
    });
  }
});
