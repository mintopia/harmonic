# Issue #163 — Wire MergeTrainCoordinator into the member-finish landing path

## Key finding (corrects the issue's premise)
Afk Epic members (mirrored + `drive:'afk'`) do NOT land via `landingEffectsFor → landBranch`.
They land via the Runner **autoDriven** land block (`driveOnce`, the `} else if (autoDriven) {`
branch), which for worktree auto-merge calls `AutoDrive.onCompleted` → `git.merge`. That is the
load-bearing seam to rewire. `landingEffectsFor`/`landBranch` is only the native
(human-accept / auto-accept) path, which epic members do not take.

The corrective-turn machinery required by AC3 (`enqueueReMerge`, `settleEscalated`, one
corrective turn in the member's Session) lives in this autoDriven path + the `drive()` loop.

## The seam
`src/execution/runner.ts` `driveOnce` autoDriven land block (~2789). For an epic auto-merge
member, route land through `MergeTrainCoordinator.submit` (first turn) / `onHealComplete`
(corrective turn) instead of `recoverAndLand`/`landReMerge` + `onCompleted`'s merge, then close
the ticket + settleAutoCompleted.

## Member identity (available at land time)
- `member.repoDir` = `task.workingDir` (base repo owning `epic/<ref>`)
- `member.integrationBranch` = `run.baseBranch` (= `epic/<ref>`)
- `member.memberBranch` = `run.branch`
- `member.memberWorktreeDir` = `workspace.worktree.path` (retained by finalizeWorkspace for
  worktree mode; agent's work already committed onto memberBranch by finalizeWorkspace)
Gate: `this.mergeTrain` set, `task.isolationMode==='worktree'`, `run.branch`,
`parseIntegrationBranch(run.baseBranch)!==null`, `workspace.worktree` present,
`autoDrive.mergeFateFor(task)==='auto-merge'`.

## Single coordinator instance + late Runner binding (app.ts)
One process-global `MergeTrainCoordinator` (holds in-memory per-branch chains + healAttempted).
```
let runnerRef: Runner | undefined;
const mergeTrain = new MergeTrainCoordinator({
  dispatchHeal: (m) => { runnerRef!.enqueueReMergeForMember(m); return Promise.resolve(); },
  escalate: (m, reason) => runnerRef!.settleEscalatedForMember(m, reason),
});
const runner = new Runner(runs, tasks, leases, db, () => configStore.get(), { ..., mergeTrain });
runnerRef = runner;
```

## Runner changes
- `RunnerOptions.mergeTrain?: MergeTrainCoordinator`; field `this.mergeTrain`.
- Field `pendingMemberReMerge = new Map<number, number>()` (runId → turn-queue row id).
- `enqueueReMergeForMember(member): void` — `enqueueReMerge(runStore.get(member.runId), \`run-${runId}\`)`,
  stash returned row id in `pendingMemberReMerge`.
- `settleEscalatedForMember(member, reason): void` — resolve task via `taskService.get`,
  run via `runStore.get`, call `settleEscalated`.
- `epicMemberFor(task, run, workspace): MergeTrainMember | null`.
- New `TurnOutcome`: `{ kind: 'merge-train-heal'; detail: string }`.
- `ReMergeContext.allowedTree` → optional (train corrective turn doesn't use it).
- autoDriven land block: epic-member branch (submit/onHealComplete → landed/already-landed/
  escalated/healing).
- `drive()`: handle `merge-train-heal` — `remerges += 1`, set `remergeCtx = {reason, detail}`,
  `healCtx = undefined`, `inFlightTurn = pendingMemberReMerge.get(run.id) ?? null`, `continue`.
  (Do NOT re-enqueue: the coordinator already did via dispatchHeal.)

## AutoDrive change
Expose `closeCompleted(task): Promise<boolean>` wrapping the private `closeTicket` (Harmonic owns
the ticket close, #139); the train replaces the merge, the close still runs.

## epic-integration.ts
Add pure `parseIntegrationBranch(name): number | null` (inverse of `integrationBranchName`,
matches `^epic/(\d+)$`).

## Escalation ownership
The coordinator's `escalate` callback (→ settleEscalatedForMember) is the SOLE settle authority on
escalate; driveOnce only records + returns terminal on `escalated` (no double settle).

## Tests (TDD order)
1. Unit: `parseIntegrationBranch`.
2. Unit: `enqueueReMergeForMember`/`settleEscalatedForMember` adapters.
3. Integration: two members on one `epic/<ref>` land serially via rebase→ff (FakeGit-style or
   real git); integration tip advances once per member; no PR/manual fallback (AC2).
4. e2e (startServer + real git): conflict on member land → exactly one corrective turn in the
   member's Session → second conflict escalates, through the wired Runner (AC3).
