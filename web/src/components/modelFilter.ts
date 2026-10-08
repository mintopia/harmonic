import { formatModelLabel } from './TaskIdentity.js';

/**
 * Options to display for the current combobox query.
 * - an empty query, or a query that exactly equals one of the options
 *   (i.e. a committed selection rather than a partial search), returns the
 *   full list so the user can reopen and browse without clearing the field;
 * - otherwise, case-insensitive substring matches on the raw id or its friendly label.
 */
export function filterModels(options: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === '' || options.some((o) => o.toLowerCase() === q)) return options;
  return options.filter((o) => o.toLowerCase().includes(q) || formatModelLabel(o).toLowerCase().includes(q));
}
