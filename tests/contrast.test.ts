import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WCAG 2.1 AA contrast floor for the Paper palette (issue #260).
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
  ['ready', 'ready', 'ready-tint'],
  ['await', 'await', 'await-tint'],
  ['merged', 'merged', 'merged-tint'],
  ['failed', 'fail', 'fail-tint'],
  ['blocked', 'muted', 'blocked-tint'],
  ['tool', 'tool', 'tool-tint'],
  // Active navigation renders teal accent text on the accent tint.
  ['accent', 'accent', 'accent-tint'],
  // Themed text selection (index.css `::selection`, issue #187): the Accent Tint
  // ground carries whatever text was selected, recoloured to Ink — a new tint
  // pairing Paper uses, so DESIGN.md § 2 requires it clear the
  // text floor in both themes before it ships.
  ['selection', 'ink', 'accent-tint'],
  // The permission band (issue #97) takes the Running amber tint as its ground
  // — the harness is blocked, "work in flight, now yours" — and carries its
  // copy in the neutral text roles on top of it: the prominent "Waiting for
  // your decision" headline in ink, the tool metadata + paused note in muted
  // (the informational floor). Both must hold AA on the amber tint so a future
  // tint nudge can't silently drown the one prompt that means the operator is
  // being asked to act.
  ['permission-band headline', 'ink', 'running-tint'],
  ['permission-band meta', 'muted', 'running-tint'],
];

const TEXT_FLOOR = 4.5;
const UI_FLOOR = 3;
const PAPER_TOKENS = ['await', 'await-dot', 'await-tint', 'on-await', 'on-done', 'sunken', 'edge-strong'] as const;

// The warm categorical token-class ramp (ADR-0014): input, output, cache-read,
// cache-write. Colour is load-bearing here, so each fill is gated below.
const TOKEN_CLASS_TOKENS = ['token-input', 'token-output', 'token-cache-read', 'token-cache-write'] as const;

describe('Paper palette meets WCAG AA in both themes (issue #260)', () => {
  it('defines the same dark tokens via data-theme and prefers-color-scheme', () => {
    // Dark values live twice (explicit toggle + system media query); they must
    // stay byte-identical or one path silently drifts below the floor.
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

      // ADR-0033 permits the vivid running amber below 4.5:1. It is never the
      // sole state signal: the pulsing dot, label, and structural position
      // carry the same meaning. Keep the exception named here so it cannot
      // quietly become an unreviewed gap in the Paper contrast gate.
      it('running amber follows the ADR-0033 light-theme exception', () => {
        const ratio = contrast(hex(t, 'running'), hex(t, 'surface'));
        if (themeName === 'light') expect(ratio).toBeLessThan(TEXT_FLOOR);
        else expect(ratio).toBeGreaterThanOrEqual(TEXT_FLOOR);
      });

      // Bright solid await and merged fills need theme-specific ink: white in
      // light, dark ink in dark. DESIGN.md §2 calls this the Ink-Flip Rule.
      for (const [label, fg, bg] of [
        ['await', 'on-await', 'await'],
        ['merged', 'on-done', 'merged'],
      ] as const) {
        it(`${label} solid-fill ink ≥ ${TEXT_FLOOR}:1`, () => {
          expect(contrast(hex(t, fg), hex(t, bg))).toBeGreaterThanOrEqual(TEXT_FLOOR);
        });
      }

      // The three text roles must read on every neutral panel background the
      // Paper palette uses Surface, Canvas, Raised, and the Sunken well (the
      // hardest, its luminance nearest the mid-tone roles). Ink is primary text;
      // Muted is the informational floor; Faint (branch names, ids, metadata,
      // zero counts, the dialog close ✕) must still clear the text floor even at
      // its quietest. All three are guarded across every Paper neutral.
      for (const role of ['ink', 'muted', 'faint'] as const) {
        for (const bg of ['surface', 'canvas', 'raised', 'sunken'] as const) {
          it(`${role} on ${bg} ≥ ${TEXT_FLOOR}:1`, () => {
            expect(contrast(hex(t, role), hex(t, bg))).toBeGreaterThanOrEqual(TEXT_FLOOR);
          });
        }
      }

      // The solid-fail destructive button (btnDestructive — workspace delete
      // confirm, issue #98) carries its label on the fail fill; it must clear
      // the text floor in both themes.
      it(`on-fail label on the fail fill ≥ ${TEXT_FLOOR}:1`, () => {
        expect(contrast(hex(t, 'on-fail'), hex(t, 'fail'))).toBeGreaterThanOrEqual(TEXT_FLOOR);
      });

      // The token-breakdown bars (ADR-0014) render each warm class fill on the
      // raised bar track; every fill must clear the 3:1 graphical-object floor
      // (WCAG 1.4.11) against that track so the class split reads in both themes.
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

      // Draft/Cancelled lanes take the Faint neutral rule (ui.ts LANE_BORDER);
      // it must be a visible divider on the canvas, not the old hairline.
      it(`neutral lane rule vs canvas ≥ ${UI_FLOOR}:1`, () => {
        expect(contrast(hex(t, 'faint'), hex(t, 'canvas'))).toBeGreaterThanOrEqual(UI_FLOOR);
      });

      // The two retuned subtle seams — Hairline (a panel's inset row-separators,
      // and the dark-theme "hairline ring standing in for the shadow", DESIGN.md
      // §4) and Edge (interactive borders: fields, ghost buttons, run chips) —
      // are deliberately BELOW the 3:1 affordance floor. The operator-relied-on
      // ≥3:1 non-text element is the Switch off-track — the one neutral DESIGN.md
      // §2 gives an explicit "held at ≥3:1" callout — not these; a seam that read
      // at 3:1 would be a rule, which Paper avoids (§4: "grouping is the
      // panel, not the rule"). They must still be a *visible* seam (never collapse
      // into the fill they sit on), but claiming the text/affordance floors here
      // would misread the design. Locking the band makes the exclusion a decision
      // rather than an omission for "every retuned pairing" (issue #180): a future
      // nudge that darkens Edge into a real 3:1 border, or lightens either seam
      // into invisibility, trips this and forces the design call. (Edge's border-
      // as-sole-affordance case — a ghost button is bg-surface on a Surface panel
      // — is the one pairing plausibly owed 3:1; flagged to design on the ticket.)
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
