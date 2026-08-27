# Issue #167 — Epic read-endpoint DTO contract (FROZEN)

Both server (`src/server/routes/epics.ts` zod schemas + `src/server/serialize.ts`)
and web (`web/src/epic-model.ts` / `web/src/types.ts`) MUST implement this shape
**identically** — there is no codegen between them, so any drift is a runtime bug,
not a type error. Do not deviate without messaging the orchestrator.

## Endpoints

- `GET /api/workspaces/:workspaceId/epics` → `{ epics: Epic[] }`
- `GET /api/workspaces/:workspaceId/epics/:epicRef` → `Epic` (404 if no such derived Epic)

Both are **operator-scope only** (mirror the force-integrate allowlist: not in the
read-scope or scoped-key allowlists → require a full operator credential).

## Types

```ts
type MemberMergeStatus = 'completed' | 'blocked' | 'pending'; // == reduceMemberState

interface EpicMember {
  ref: number;                 // member ticket ref
  title: string;               // member title (from ticket/task; '' if unknown)
  taskId: number | null;       // mirrored Harmonic Task id for TaskDetail deep-link; null if unmirrored
  state: string | null;        // raw TaskState (running|completed|failed|cancelled|...) or null if unmirrored
  escalated: boolean;
  mergeStatus: MemberMergeStatus;
  ready: boolean;              // member is in the ready frontier
}

interface EpicIntegration {
  branch: string;              // 'epic/<ref>'
  exists: boolean;
  tip: string | null;          // short/long commit oid at branch tip, null if branch absent
}

interface EpicVerification {
  status: 'pass' | 'fail' | 'pending' | null; // whole-Epic verification result; null if unknown/not-run
}

interface EpicIntegrateState {
  inFlight: boolean;           // a whole-Epic integrate attempt is running right now
  held: string | null;        // escalation/hold reason if the coordinator is holding; else null
}

interface Epic {
  ref: number;
  title: string;
  kind: 'map' | 'spec';
  members: EpicMember[];       // ascending by ref
  ready: number[];             // ready-frontier refs (ascending)
  integration: EpicIntegration;
  verification: EpicVerification;
  integrate: EpicIntegrateState;
  foldedCount: number;         // members with mergeStatus === 'completed'
  memberCount: number;         // members.length
}
```

## Force-integrate binding (already exists server-side)

`POST /api/workspaces/:workspaceId/epics/:epicRef/force-integrate` →
`EpicLandOutcome` = discriminated union on `status`:
`{status:'integrated', oid} | {status:'blocked', reason} | {status:'waiting', reason}
| {status:'escalated', reason} | {status:'noop', reason} | {status:'busy'}`.

Add `api.forceLandEpic(workspaceId, epicRef)` in `web/src/api.ts`.

## Sourcing notes (server)

- `deriveEpics(tickets)` needs the last poll scan's raw `Ticket[]` — cache it per
  workspace entry in `TrackerPollerManager` (set where `reconcile(tickets, mirrored)`
  is already called in the poll loop) and expose an accessor.
- `reduceMemberState(taskRow | undefined)` → mergeStatus. Member task rows via
  `TaskService.list({ workspaceId })`, matched to member refs by `trackerRef`.
- Integration tip/exists: `integrationBranchName(ref)` + `EpicGit.branchExists` +
  git `revParse` (as `EpicIntegrateCoordinator` does). If no epic-integrate coordinator is
  active for the workspace, return `exists:false, tip:null`.
- `verification.status`: source the whole-Epic Verification result if cleanly
  reachable; otherwise return `null` and leave a `// ponytail:` note — do NOT
  invent a store. `integrate.inFlight`: expose from `EpicIntegrateCoordinator` (its private
  `inFlight` Set) via a new public getter; `held` from its escalation/hold state
  if reachable, else `null`.
- Keep the composition split: a **pure** composer function in `src/domain`
  (takes derivedEpic + member task rows + branch facts + integrate/verification facts,
  returns the `Epic` DTO — unit-testable) and an **impure** manager accessor that
  gathers the git/coordinator facts and calls the pure composer.
