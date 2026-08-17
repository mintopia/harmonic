/**
 * Keyboard navigation for the task-detail review tablist (issue #95).
 *
 * The tabs (Description / Prompt / Output / Changes / Details) use a roving
 * tabindex — exactly one tab sits in the Tab order — so a keyboard operator
 * Tabs into the tablist as a single stop and then moves between tabs with the
 * arrow keys. Without an arrow handler the later tabs were simply unreachable.
 *
 * This is the pure part: map a pressed key to the index that focus should move
 * to, following the WAI-ARIA tablist pattern (Left/Right wrap around the ends,
 * Home/End jump to first/last). Returns `null` for any key that is not tablist
 * navigation so the caller leaves the event untouched.
 *
 * `current` is the index of the currently-focused tab, or a negative number
 * when focus is not yet on any tab; in that case Right lands on the first tab
 * and Left on the last.
 */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowLeft':
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
