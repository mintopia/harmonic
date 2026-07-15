# Model Combobox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the task form's native-`<datalist>` model input with a custom combobox that shows a definite, browsable list of the harness's configured models while still allowing any ID to be typed.

**Architecture:** A new controlled React component `ModelCombobox` renders the shared `field` input plus a chevron button that toggles a styled listbox of options. Option filtering is delegated to a pure, unit-tested helper `filterModels`. The component owns only transient UI state (open, highlight); the selected value stays controlled by `TaskForm` via `value`/`onChange`, so arbitrary/suffixed IDs pass through unchanged. It replaces the input+datalist block in `TaskForm` without touching any surrounding form state.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4 (custom design tokens in `web/src/index.css` / `web/src/ui.ts`), Vitest.

## Global Constraints

- Free typing of arbitrary model IDs MUST be preserved, including reasoning-effort suffixes like `gpt-5.4-mini[low]`. The stored value is always exactly the input text.
- Model IDs render in the mono data font: classes `font-data text-data` (the Mono-Is-Data rule). Never use mono for non-data UI text.
- Only use color tokens that exist in `web/src/index.css` (`surface`, `field`, `raised`, `edge`, `ink`, `muted`, `faint`, `accent`, `accent-tint`, `accept`). Do not invent classes.
- Icons come only from `web/src/components/Icon.tsx` (stroke, `currentColor`, 16×16). No emoji, no icon-font dependency.
- Scope is the `TaskForm` model field only. Do NOT change `HarnessSettings.tsx`, `TaskDetail.tsx`, or the re-attempt dialog.
- No DOM/component test harness (Testing Library / jsdom) exists; do not add one. Automated tests cover pure logic only (`tests/**/*.test.ts`).
- Verification commands: `npm test` (vitest), `npm run typecheck` (`tsc -p tsconfig.test.json && tsc -p web/tsconfig.json`), `npm run build`.

---

### Task 1: Pure option-filter helper

**Files:**
- Create: `web/src/components/modelFilter.ts`
- Test: `tests/model-filter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `filterModels(options: string[], query: string): string[]` — the options to display for the current query. Empty query, or a query exactly equal to one option (a committed selection), returns the full list; otherwise case-insensitive substring matches.

- [ ] **Step 1: Write the failing test**

Create `tests/model-filter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { filterModels } from '../web/src/components/modelFilter.js';

const MODELS = ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5'];

describe('filterModels', () => {
  it('returns the full list for an empty or whitespace query', () => {
    expect(filterModels(MODELS, '')).toEqual(MODELS);
    expect(filterModels(MODELS, '   ')).toEqual(MODELS);
  });

  it('returns the full list when the query exactly equals an option', () => {
    expect(filterModels(MODELS, 'claude-opus-4-8')).toEqual(MODELS);
  });

  it('filters to case-insensitive substring matches', () => {
    expect(filterModels(MODELS, 'opus')).toEqual(['claude-opus-4-8']);
    expect(filterModels(MODELS, 'ku-4')).toEqual(['claude-haiku-4-5']);
    expect(filterModels(MODELS, 'CLAUDE')).toEqual(MODELS);
  });

  it('returns an empty list when nothing matches (a custom ID)', () => {
    expect(filterModels(MODELS, 'gpt-5.4-mini[low]')).toEqual([]);
  });

  it('handles an empty option list', () => {
    expect(filterModels([], 'anything')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- model-filter`
Expected: FAIL — cannot resolve `../web/src/components/modelFilter` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `web/src/components/modelFilter.ts`:

```ts
/**
 * Options to display for the current combobox query.
 * - an empty query, or a query that exactly equals one of the options
 *   (i.e. a committed selection rather than a partial search), returns the
 *   full list so the user can reopen and browse without clearing the field;
 * - otherwise, case-insensitive substring matches.
 */
export function filterModels(options: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === '' || options.some((o) => o.toLowerCase() === q)) return options;
  return options.filter((o) => o.toLowerCase().includes(q));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- model-filter`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/modelFilter.ts tests/model-filter.test.ts
git commit -m "feat: pure filterModels helper for the model combobox"
```

---

### Task 2: ModelCombobox component wired into TaskForm

**Files:**
- Modify: `web/src/components/Icon.tsx` (add a `check` glyph)
- Create: `web/src/components/ModelCombobox.tsx`
- Modify: `web/src/components/TaskForm.tsx:85-97` (replace the input + datalist)

**Interfaces:**
- Consumes: `filterModels(options, query)` from Task 1; `Icon` from `web/src/components/Icon.tsx`; `field` from `web/src/ui.ts`.
- Produces: `ModelCombobox` React component with props `{ id?: string; value: string; onChange: (value: string) => void; options: string[] }`.

- [ ] **Step 1: Add a `check` glyph to the icon vocabulary**

In `web/src/components/Icon.tsx`, add `'check'` to the `IconName` union (after `'circle-half'`):

```ts
  | 'circle-half'
  | 'check';
```

And add its path to the `PATHS` record (after the `'circle-half'` entry):

```tsx
  // Selection tick for list options.
  check: <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />,
```

- [ ] **Step 2: Verify types still compile**

Run: `npm run typecheck`
Expected: PASS (no errors; `check` is now a valid `IconName`).

- [ ] **Step 3: Create the ModelCombobox component**

Create `web/src/components/ModelCombobox.tsx`:

```tsx
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { field } from '../ui';
import { Icon } from './Icon';
import { filterModels } from './modelFilter';

/**
 * Model picker: a text field that stays free-typeable (arbitrary and
 * suffixed IDs like `gpt-5.4-mini[low]` commit as-is) fronted by a definite,
 * browsable list of the harness's configured models — the native <datalist>
 * it replaces gave no reliable dropdown affordance. The value is controlled
 * by the parent; this component owns only open/highlight state.
 */
export function ModelCombobox({
  id,
  value,
  onChange,
  options,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const wrap = useRef<HTMLDivElement>(null);
  const listId = useId();

  const shown = filterModels(options, value);
  const custom = value.trim() !== '' && shown.length === 0;

  // Close on any pointer press outside the widget. The panel lives inside the
  // task-form <dialog>, so a click elsewhere in the form should dismiss it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const openList = () => {
    setOpen(true);
    setHighlight(-1);
  };

  const commit = (v: string) => {
    onChange(v);
    setOpen(false);
    setHighlight(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) {
        openList();
        return;
      }
      setHighlight((h) => Math.min(h + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      // While the list is open, Enter picks/closes and never submits the form.
      if (open) {
        e.preventDefault();
        if (highlight >= 0 && highlight < shown.length) commit(shown[highlight]);
        else setOpen(false);
      }
    } else if (e.key === 'Escape') {
      // Swallow Escape so the surrounding <dialog> stays open.
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    }
  };

  return (
    <div ref={wrap} className="relative">
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        className={`${field} font-data pr-8`}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onFocus={openList}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? 'Hide models' : 'Show models'}
        className="absolute inset-y-0 right-0 flex items-center px-2.5 text-muted transition-colors duration-150 hover:text-ink"
        onClick={() => (open ? setOpen(false) : openList())}
      >
        <Icon
          name="chevron-down"
          className={`transition-transform duration-150 ${open ? 'rotate-0' : '-rotate-90'}`}
        />
      </button>

      {open && (shown.length > 0 || custom) && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-10 mt-1 max-h-56 w-full overflow-auto rounded-md border border-edge bg-surface py-1 shadow-card"
        >
          {shown.map((m, i) => (
            <li
              key={m}
              role="option"
              aria-selected={m === value}
              className={`flex cursor-pointer items-center justify-between px-2.5 py-1.5 font-data text-data ${
                i === highlight ? 'bg-raised' : ''
              }`}
              onPointerDown={(e) => {
                e.preventDefault(); // keep focus on the input
                commit(m);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              <span>{m}</span>
              {m === value && <Icon name="check" className="text-accent" />}
            </li>
          ))}
          {custom && (
            <li className="px-2.5 py-1.5 text-data text-muted">
              Use custom ID: <span className="font-data text-ink">{value}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire it into TaskForm**

In `web/src/components/TaskForm.tsx`, add the import after the existing component imports (near line 4):

```tsx
import { ModelCombobox } from './ModelCombobox';
```

Then replace the whole model input + datalist block (currently lines 86–97, the `<input id="task-model" ...>` element and the `<datalist id="models"> ... </datalist>`) with a single element, leaving the `<label>` on line 85 untouched:

```tsx
            <ModelCombobox id="task-model" value={model} onChange={setModel} options={models} />
```

The surrounding `<div>`, the `<label htmlFor="task-model">Model (pick or type any ID)</label>`, the `model`/`setModel` state (line 22), `const models = ...` (line 29), and `pickHarness` (lines 50–54) all stay exactly as they are.

- [ ] **Step 5: Verify types and build**

Run: `npm run typecheck && npm run build`
Expected: PASS — no type errors; Vite build succeeds. (Confirms the `<datalist>` is gone and `ModelCombobox` typechecks against `models: string[]` and `setModel`.)

- [ ] **Step 6: Manual verification in the running app**

Run: `npm run dev` and open the app; click **New task**.
Confirm, in the Model field:
1. A chevron shows on the right; clicking it opens a list of the selected harness's models.
2. The current model row shows an accent check; clicking another row selects it and closes the list.
3. Typing `opus` filters to matching options; typing `gpt-5.4-mini[low]` shows the muted "Use custom ID" row and Enter/blur keeps that exact value.
4. ↓/↑ move the highlight, Enter picks it, Escape closes the list **without** closing the task-form modal.
5. Changing the Harness dropdown resets the model to that harness's default.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/Icon.tsx web/src/components/ModelCombobox.tsx web/src/components/TaskForm.tsx
git commit -m "feat: definite-but-typeable model combobox in the task form"
```

---

## Self-Review

**Spec coverage:**
- Custom combobox component with `{id?, value, onChange, options}` → Task 2. ✅
- TaskForm integration, existing state/harness-reset untouched → Task 2 Step 4. ✅
- Chevron affordance, open/close, ✓ on current value → Task 2 (chevron + `check` glyph). ✅
- Filter rule (empty/exact→all, else substring), custom-ID hint → Task 1 helper + Task 2 `custom` row. ✅
- Arbitrary/suffixed IDs preserved → controlled `value`, verified in Task 2 Step 6.3. ✅
- Keyboard + Escape-doesn't-close-modal + a11y roles → Task 2 Step 3 handler and roles. ✅
- Styling on real tokens, mono for IDs → Task 2 Step 3 classes; Global Constraints. ✅
- Unit test of filter under `tests/**/*.test.ts`; no DOM harness added → Task 1. ✅
- Non-goals (HarnessSettings, TaskDetail, re-attempt) untouched → Global Constraints; no tasks touch them. ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows complete code. ✅

**Type consistency:** `filterModels(options: string[], query: string): string[]` defined in Task 1 and consumed identically in Task 2. `ModelCombobox` props defined in Task 2 match the `<ModelCombobox value={model} onChange={setModel} options={models} />` call (`model: string`, `setModel: (v: string) => void`, `models: string[]`). `check` added to `IconName` before use. ✅
