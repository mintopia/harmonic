declare const __HARMONIC_VERSION__: string | undefined;

/** The package version this bundle was built from; null outside a Vite build (tests, stories). */
export const BUILD_VERSION: string | null = typeof __HARMONIC_VERSION__ === 'string' ? __HARMONIC_VERSION__ : null;
