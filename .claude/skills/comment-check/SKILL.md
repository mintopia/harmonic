---
name: comment-check
description: "Read-only comment-discipline check for the critic. Dispatches the comment-critic subagent over a scope and reports its PASS/FAIL verdict. Use for /comment-check, a critic quality gate, or verifying a diff for narration, workaround sermons, and unsafe lint/TS suppressions. Never edits code."
---

# Comment check

The read-only sibling of `no-comments`. That skill deletes and fixes; this one
only checks. Dispatch the `comment-critic` subagent, then report its verdict
verbatim. Touch nothing — no deletions, no fixes, no edits. The caller (a critic
or a human) decides what to do with the findings.

## Scope

Use the caller's files or diff. Otherwise use the current diff against the base
branch (default `develop`), including the working tree.

## Steps

1. **Dispatch the check.** Launch one `comment-critic` subagent via the Agent
   tool. Pass only the scope (the files or diff) as its prompt. The agent is
   read-only and runs on its own model — do not restate its rules or override
   its model; the agent definition is authoritative.

2. **Report the verdict.** Surface the subagent's report unchanged: the
   violation list, the skips, and its final `COMMENT-CHECK: PASS` or
   `COMMENT-CHECK: FAIL (<n>)` line. Do not edit, delete, or fix anything. Do
   not re-argue its calls. If the run produced no verdict line, say so and treat
   the check as errored, not passed.
