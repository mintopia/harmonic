# Every UI action triggers a full page reload to a blank page

Status: fixed (pending commit)

## Parent

Reported during QA session (2026-07-14)

## What happened

Performing any action in the AgentDeck web UI — toggling the Auto-Runner,
creating a New Task, promoting or running a Task, Accept/Reject on a Task
awaiting review — causes the browser to do a full page reload that lands on
a blank page. Manually reloading the page brings the app back, and the
action has usually taken effect by then.

## What I expected

AgentDeck is a single-page app: actions should be applied in place via the
API, with the board/table updating live. No action should cause browser
navigation, and the app should never render blank.

## Steps to reproduce

1. Serve AgentDeck and log in as the operator.
2. Perform any action — e.g. toggle the Auto-Runner in the header, or
   create a New Task.
3. Observe the page reloads and renders blank.
4. Manually reload the page: the app comes back and the action has usually
   taken effect.

## Additional context

- Happens consistently for every action, not just one surface.
- Two distinct smells combine here: (1) actions trigger browser navigation
  at all, when the app handles everything with in-page API calls, and
  (2) the reloaded location does not serve the app shell, which is why the
  result is a blank page rather than a reloaded app. Fixing (1) should make
  (2) unreachable, but blank-on-manual-reload may be worth checking
  separately — a user refreshing in any state should always get the app
  back.
- The most recent UI change touched the login form (adding a username
  field), so the auth/session flow is a plausible place the regression came
  in — e.g. API calls being treated as unauthenticated and bouncing through
  a navigation.
- Browser console/URL details were not captured; reproducing with devtools
  open should show whether requests fail before the reload.

## Comments

**2026-07-14 (agent):** Diagnosed and fixed. There was never any
navigation — a headless-browser repro (login → toggle Auto-Runner →
create task, counting `framenavigated` events) showed zero navigations.
The "blank page" was React unmounting the whole tree on a render crash:
the WebSocket `task_changed` broadcast sent the raw `TaskRow` (no
`dependsOn`/`dependents`/`blockedOnFailed`), while every REST route
serializes tasks through `withDeps`. `App.tsx` merges WS payloads
straight into its task list, so `TaskCard`'s `task.dependsOn.length`
threw (`Cannot read properties of undefined (reading 'length')`),
blanking `#root`. Manual reload refetches complete tasks via REST, which
is why the app "came back with the action applied". Any action that
changes any task triggered it; the suspected login/auth regression was
ruled out — the bug is latent since dependencies landed on cards.

Fix: `ws.ts` now enriches `task_changed` payloads with
`ctx.tasks.withDeps(task)`, matching the REST shape. Regression test in
`tests/streaming.test.ts` asserts the WS payload deep-equals the REST
response. Full suite (71) and typecheck pass; the browser loop passes.

Prevention notes: (1) the SPA root has no React error boundary, so any
render error blank-pages the entire app; (2) the WS boundary is
type-unchecked — `ws.ts` sent a `TaskRow` where the client type promised
`Task` and nothing complained. Worth folding into issue 18's hardening
or a follow-up.
