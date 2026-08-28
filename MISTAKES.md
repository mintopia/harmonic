# Mistakes

- 2026-08-28: The agent critic was never wired to receive the two revisions (base + candidate SHAs) despite Jess repeatedly asking for it; the recurring "no changed files or symbols" failure was mis-filed as a wrong-tree/staleness bug, so prior sessions kept patching only the candidate index instead of indexing both revisions. *Resolved: fixed in `327c47f`, and the requirement is now doctrine in ADR-0003 (the critic is given both revisions).*
