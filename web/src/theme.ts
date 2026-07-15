/**
 * Theme preference (DESIGN.md § Colors): both themes are first-class.
 * `system` follows prefers-color-scheme; an explicit choice stamps
 * data-theme on <html>, which the token layer lets win in both
 * directions. Storage is injected so the node-side test project can
 * exercise the logic; the app passes window.localStorage.
 */
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export const THEME_KEY = 'harmonic.theme';

export const THEME_PREFS = ['system', 'light', 'dark'] as const;
export type ThemePref = (typeof THEME_PREFS)[number];

export function loadTheme(storage: StorageLike): ThemePref {
  try {
    const raw = storage.getItem(THEME_KEY);
    return THEME_PREFS.includes(raw as ThemePref) ? (raw as ThemePref) : 'system';
  } catch {
    return 'system'; // private browsing etc. — follow the OS
  }
}

export function storeTheme(storage: StorageLike, pref: ThemePref): void {
  try {
    storage.setItem(THEME_KEY, pref);
  } catch {
    // best-effort: losing persistence must not break the toggle
  }
}

export function nextTheme(pref: ThemePref): ThemePref {
  return THEME_PREFS[(THEME_PREFS.indexOf(pref) + 1) % THEME_PREFS.length] ?? 'system';
}

export function applyTheme(root: HTMLElement, pref: ThemePref): void {
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
}
