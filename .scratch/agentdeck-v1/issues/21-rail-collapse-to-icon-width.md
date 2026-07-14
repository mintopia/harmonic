# Rail collapses to icon width on desktop

Status: ready

## Parent

Design system init (2026-07-14) — `DESIGN.md` § Navigation (the Rail)

## Context

Issue 19 shipped the left-rail shell with the mobile top-drawer collapse.
DESIGN.md also specifies the desktop half: "slim fixed left rail (~200px,
**collapsible to icon width**)". It was deferred from issue 19 because the
rail's items are text-only and the system has no icon vocabulary yet —
collapsing to icons is scope beyond that issue's acceptance criteria.

## What to build

1. **Icon vocabulary**: a minimal inline-SVG set (stroke style, one weight,
   `currentColor`) for Board / Table / Stats / Channels / Keys / Log out.
   No emoji, no icon-font dependency; per PRODUCT.md anti-references this
   must not drift toward chat-app cuteness.
2. **Collapse toggle**: a control pinned in the rail (bottom, above the
   account group, or a hairline chevron on the rail edge) that switches the
   rail between ~200px (icon + label) and ~36px (icon only) — the same rail
   width vocabulary the board's terminal columns use.
3. **Collapsed behavior**: icon-only items keep full a11y — `aria-label`,
   native `title` tooltip, visible focus ring, active state still Console
   Raised fill + Signal Cyan icon (the rail's only cyan).
4. **Persistence**: remember the choice in `localStorage`; default expanded.
   Below the 900px breakpoint the top-drawer behavior from issue 19 wins.
5. **Motion**: width transition 150ms ease-out with a
   `prefers-reduced-motion` instant alternative.

## Acceptance criteria

- [ ] Rail toggles between ~200px and icon width (~36px) on desktop; choice persists across reloads
- [ ] Collapsed items expose labels via `aria-label` + tooltip; keyboard paths and focus-visible unchanged (WCAG 2.1 AA, no regression from issue 19)
- [ ] Active-item treatment holds in both widths and both themes (Dark + Daylight)
- [ ] One Phosphor / Flat Field / Hairline rules hold; icons are `currentColor` line icons, no decorative color
- [ ] Mobile top-drawer behavior from issue 19 is unaffected

## Blocked by

Nothing.
