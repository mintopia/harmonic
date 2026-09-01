// A non-existent CLI name, so no test shells out to the real jCodeMunch binary
// or mutates the shared code-index store.
process.env.HARMONIC_CODE_INDEX_CLI = 'harmonic-test-no-code-index-cli';
