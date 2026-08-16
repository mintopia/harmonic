import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 2.1 AA contrast floor for the Aurora palette (issue #87).
 *
 * DESIGN.md § 2 claims every informational pairing holds AA "in both themes".
 * This test computes the actual contrast ratio of every documented token
 * pairing straight from the source of truth — the `--hm-*` custom properties in
 * `web/src/index.css` — and fails the build if any drops below its floor, so a
 * token nudge can never silently regress light *or* dark again.
 *
 * Floors (WCAG 2.1): 4.5:1 for normal-size text (1.4.3); 3:1 for UI components
 * and graphical objects (1.4.11) — the Switch off-track and the neutral lane
 * rules. The knob is Tailwind `bg-white` (Switch.tsx) and the card behind a
 * Switch is `--hm-surface`; the neutral lane rule sits on `--hm-canvas`.
 */

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

/**
 * Pull one CSS rule's `--hm-*` declarations into a name→value map. `selector`
 * matches the rule's selector up to and including its opening brace (a regex, so
 * whitespace/formatting can vary); we then brace-count so the nested media rule
 * doesn't confuse the scan.
 */
function tokensIn(css: string, selector: RegExp): Record<string, string> {
  const m = selector.exec(css);
  if (!m) throw new Error(`token block not found: ${selector}`);
  let depth = 0;
  let i = m.index + m[0].length - 1; // sits on the opening `{`
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

const light = tokensIn(CSS, /:root\s*\{/); // first `:root{` in the file is the light block
const darkExplicit = tokensIn(CSS, /:root\[data-theme='dark'\]\s*\{/);
const darkSystem = tokensIn(CSS, /:root:not\(\[data-theme='light'\]\)\s*\{/);
const themes = { light, dark: darkExplicit } as const;

/** Resolve a token to its hex, failing loudly if the pass ever drops one. */
function hex(tokens: Record<string, string>, name: string): string {
  const value = tokens[name];
  if (value === undefined) throw new Error(`missing token: --hm-${name}`);
  return value;
}

/** Documented text-on-tint state pairings (DESIGN.md § 2; ui.ts STATE_CHIP_STYLES). */
const TEXT_ON_TINT: ReadonlyArray<readonly [string, string, string]> = [
  ['running', 'running', 'running-tint'],
  ['ready', 'ready', 'ready-tint'],
  ['completed', 'accept', 'accept-tint'],
  ['failed', 'fail', 'fail-tint'],
  ['blocked', 'blocked', 'blocked-tint'],
  ['tool', 'tool', 'tool-tint'],
  // awaiting-review and active-nav render accent text on the accent tint.
  ['accent', 'accent', 'accent-tint'],
];

const TEXT_FLOOR = 4.5;
const UI_FLOOR = 3;

describe('Aurora palette meets WCAG AA in both themes (issue #87)', () => {
  it('defines the same dark tokens via data-theme and prefers-color-scheme', () => {
    // Dark values live twice (explicit toggle + system media query); they must
    // stay byte-identical or one path silently drifts below the floor.
    expect(darkSystem).toEqual(darkExplicit);
  });

  for (const [themeName, t] of Object.entries(themes)) {
    describe(themeName, () => {
      for (const [label, fg, bg] of TEXT_ON_TINT) {
        it(`state text-on-tint: ${label} ≥ ${TEXT_FLOOR}:1`, () => {
          expect(contrast(hex(t, fg), hex(t, bg))).toBeGreaterThanOrEqual(TEXT_FLOOR);
        });
      }

      // Faint must read as text (branch names, ids, metadata, zero counts, the
      // dialog close ✕) on every neutral background — including the raised inset
      // fill, which is the hardest (its luminance is nearest faint's mid-tone).
      // Muted is the informational floor.
      for (const role of ['faint', 'muted'] as const) {
        for (const bg of ['surface', 'canvas', 'raised'] as const) {
          it(`${role} on ${bg} ≥ ${TEXT_FLOOR}:1`, () => {
            expect(contrast(hex(t, role), hex(t, bg))).toBeGreaterThanOrEqual(TEXT_FLOOR);
          });
        }
      }

      it(`Switch off-track: knob vs track ≥ ${UI_FLOOR}:1`, () => {
        expect(contrast(WHITE, hex(t, 'switch-off'))).toBeGreaterThanOrEqual(UI_FLOOR);
      });
      it(`Switch off-track: track vs card ≥ ${UI_FLOOR}:1`, () => {
        expect(contrast(hex(t, 'switch-off'), hex(t, 'surface'))).toBeGreaterThanOrEqual(UI_FLOOR);
      });

      // Draft/Cancelled lanes take the Faint neutral rule (ui.ts LANE_BORDER);
      // it must be a visible divider on the canvas, not the old hairline.
      it(`neutral lane rule vs canvas ≥ ${UI_FLOOR}:1`, () => {
        expect(contrast(hex(t, 'faint'), hex(t, 'canvas'))).toBeGreaterThanOrEqual(UI_FLOOR);
      });
    });
  }
});
