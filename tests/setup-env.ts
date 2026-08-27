// Point the jCodeMunch code-index CLI (`src/execution/code-index.ts`) at a name
// that does not exist, so no test ever shells out to the real binary or mutates
// the shared code-index store. The wrapper degrades a missing CLI to a silent
// skip, so builder/critic paths behave exactly as they do without the
// integration. Tests that specifically cover the wrapper override this env and
// reset the cached availability probe themselves.
process.env.HARMONIC_CODE_INDEX_CLI = 'harmonic-test-no-code-index-cli';
