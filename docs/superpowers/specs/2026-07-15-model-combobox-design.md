# Model picker: definite list + free typing

**Date:** 2026-07-15
**Status:** Approved, ready for implementation plan
**Surface:** Task execution form (`web/src/components/TaskForm.tsx`)

## Problem

The Model field in the task form (`TaskForm.tsx:84-98`) is a free-text `<input>`
backed by a native `<datalist>` (label: *"Model (pick or type any ID)"*). It
already lets you type any ID and offers per-harness suggestions, but a native
`<datalist>` is a weak dropdown: the suggestion affordance is inconsistent across
browsers (often no visible arrow, appears only on keystroke, filters away as you
type), so it does not read as a real, browsable list of options.

Free typing is **deliberate** and must be preserved — config comments note
operators run models outside the suggestion list, and IDs can carry a
reasoning-effort suffix such as `gpt-5.4-mini[low]` (`src/config.ts:101,112-117`).

## Goal

Replace the datalist input with a custom combobox that presents a **definite,
obviously browsable list** of the harness's configured models while still
allowing an arbitrary ID to be typed and committed.

Non-goals (explicitly out of scope):
- Settings default-model `<select>` (`HarnessSettings.tsx:174-190`) — unchanged.
- TaskDetail read-only model display (`TaskDetail.tsx:361`) — unchanged.
- Re-attempt dialog — unchanged (does not let you change the model today).
- No remote model-catalog fetch; options remain the per-harness config list.

## Design

### New component: `web/src/components/ModelCombobox.tsx`

A self-contained combobox. Props:

```ts
interface ModelComboboxProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
}
```

The component owns only transient UI state (open/closed, highlighted index). The
selected value is fully controlled by the parent via `value`/`onChange` — the
stored value is always exactly the input text, so arbitrary/suffixed IDs pass
through unchanged.

### Integration in TaskForm

Swap the current input + `<datalist>` block (`TaskForm.tsx:84-98`) for:

```jsx
<label className={label} htmlFor="task-model">Model (pick or type any ID)</label>
<ModelCombobox id="task-model" value={model} onChange={setModel} options={models} />
```

Everything else in TaskForm stays as-is:
- `model`/`setModel` state (line 22).
- `const models = config.harnesses[harness]?.models ?? []` (line 29) → passed as `options`.
- `pickHarness` resetting `model` to the harness `defaultModel` on harness change (lines 50-54).
- `fields.model` submitted to the API (line 35).

### Behavior

- **Closed:** renders like today's field — the shared `field` class, mono
  `font-data`, showing `value` — plus a visible **▾ chevron button** on the right
  that toggles the panel.
- **Open** (click field or chevron, or focus + typing): a panel drops below
  listing the filtered options; the option equal to the current `value` is
  marked with a ✓.
- **Typing:** edits `value` live via `onChange` and filters the option list (see
  filter rule below).
- **Select:** clicking an option or pressing Enter on the highlighted one sets
  `value` to it and closes.
- **Custom ID:** when the typed text matches no option, the panel shows a single
  muted row `Use custom ID: "<value>"` — reinforcing that typing is allowed
  alongside the list. Committing (Enter/blur) keeps the typed text.
- **Keyboard:** ↓/↑ move the highlight, Enter commits the highlighted option (or
  the typed text if none highlighted) and closes, Escape closes keeping the typed
  value, Tab and outside-click close.

### Filter rule (pure, unit-tested)

Extracted into its own React-free helper so it can be unit-tested under the
existing vitest setup:

`web/src/components/modelFilter.ts`

```ts
/** Options to show for the current query.
 *  - empty query OR query exactly equal to an option → the full list
 *    (so a user can reopen after selecting and browse without clearing);
 *  - otherwise case-insensitive substring matches. */
export function filterModels(options: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === '' || options.some((o) => o.toLowerCase() === q)) return options;
  return options.filter((o) => o.toLowerCase().includes(q));
}
```

### Styling

Reuse the design vocabulary in `web/src/ui.ts` and DESIGN.md tokens:
- Input shell: the shared `field` class + `font-data`.
- Chevron: quiet icon button inside the field, `text-muted` → `text-ink` on hover.
- Panel: `absolute` within a `relative` wrapper, `bg-surface shadow-card rounded-md
  border border-edge`, layered above sibling form fields, inside the existing
  modal `<dialog>`.
- Options: `font-data` (mono — the Mono-Is-Data rule for model IDs), highlighted
  row `bg-raised`, custom-ID hint row `text-muted`.

### Accessibility

- Input: `role="combobox"`, `aria-expanded`, `aria-controls` pointing at the panel.
- Panel: `role="listbox"`.
- Options: `role="option"`, `aria-selected` on the current value.
- Escape-to-close and focus handling mirror `Modal.tsx` conventions.

## Testing & verification

- **Unit:** `tests/model-filter.test.ts` (fits the existing `tests/**/*.test.ts`
  vitest include) covering `filterModels`: empty query → all; exact-match query →
  all; substring → matches only; no-match → empty; case-insensitivity.
- **Manual:** interactive/visual behavior (open/close, chevron, keyboard nav,
  custom-ID commit, harness-change reset) verified in the running app.
- No DOM/component test harness (Testing Library / jsdom) exists and none is
  added for this change.
