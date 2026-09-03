// A non-existent CLI name, so no test shells out to the real jCodeMunch binary
// or mutates the shared code-index store.
process.env.HARMONIC_CODE_INDEX_CLI = 'harmonic-test-no-code-index-cli';

// Node 22+ ships a global `localStorage` that stays undefined without
// --localstorage-file, and it shadows the one jsdom would otherwise install.
// In browser-like (jsdom) test envs, provide a working in-memory Storage.
if (typeof window !== 'undefined' && globalThis.localStorage == null) {
  const map = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true });
}
