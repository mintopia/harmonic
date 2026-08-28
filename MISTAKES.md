# Mistakes

- 2026-08-28: The agent critic was never wired to receive the two revisions (base + candidate SHAs) despite Jess repeatedly asking for it; the recurring "no changed files or symbols" failure was mis-filed as a wrong-tree/staleness bug, so prior sessions kept patching only the candidate index instead of indexing both revisions.
