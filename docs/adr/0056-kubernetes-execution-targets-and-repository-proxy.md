# Decision: Kubernetes Execution Targets run workflow steps in pods behind a Repository Proxy

Status: accepted
Date: 2026-10-30

A Task Execution Workflow (ADR-0053) can run on an **Execution Target** named
by `runs_on`, at the workflow level (one pod for the Ticket's execution) or at
the step level (a fresh pod per step). `local`, the Harmonic host, is built in;
operators add named Kubernetes targets. Harmonic stays the only controller: it
attaches to the Harness's stdio through the Kubernetes API. Pods reach git only
through a **Repository Proxy**, one per cluster, with a signed per-Ticket pass
that allows fetching the base and the Ticket branch and pushing the Ticket
branch. Amends ADR-0001's "one Node process against local repositories"
clause.

## Context

ADR-0001 sets Harmonic's design ceiling at one Node process against local
repositories for one operator. Every Attempt runs on the Harmonic host, so
concurrency is bounded by that host (the Host Ceiling, ADR-0009), and every
Harness shares the host's filesystem, credentials and network. An operator
with a Kubernetes cluster can run many more Attempts, with each Ticket isolated
in its own pod, but only if pods can run Harnesses and push work without
holding the Code Repository's credentials or reaching anything else.

## Decision

### Execution Targets

- **`runs_on` at workflow and step level.** Workflow-level runs the Ticket's
  execution in one pod and keeps the warm Session. Step-level runs each step
  in a fresh pod, with a cold Session for each agent step.
- **`local` is built in.** Operators add named Kubernetes targets, each with
  cluster access, a namespace, a default pod image, CPU and memory, a
  concurrency limit, and the Repository Proxy's URL.
- **Cluster access** is a kubeconfig stored as an ADR-0046 Secret, or the
  in-cluster service account when Harmonic itself runs in the cluster.
- **Global configuration.** A Workspace may restrict which targets it uses.
- **Local and Kubernetes steps may mix in one workflow.** The handover between
  steps goes through the checkpoint push: the next step's target, the `local`
  worktree included, fetches the Ticket branch from the remote. This needs a
  Code Repository, as every Kubernetes target does.
- **A disabled target** keeps its waiting Tickets `ready`, showing "waiting
  for <target>". **A deleted target** escalates its waiting Tickets, naming
  it.

### Control channel

- **Harmonic is the only controller.** It attaches to the Harness's stdio
  through the Kubernetes API, in the manner of `kubectl exec`.
- **No inbound ports on pods and no extra agent inside the pod.**

### Repository Proxy

- **One proxy service per cluster**, not a sidecar per pod. It holds the real
  Code Repository credentials. Operators install it from a plain manifest
  shipped at `deploy/kubernetes/repository-proxy.yaml`; the target
  configuration holds its URL.
- **Pods hold a per-Ticket pass.** The pass is stateless and signed by Harmonic
  with a key shared with the proxy. It encodes the Code Repository, the base
  branch, the Ticket branch and an expiry of 24 hours, and a fresh pass is
  issued at every pod start. Rotating the key revokes every pass.
- **Rules**: fetch the base branch and the Ticket's own branch only; push,
  force included (the Rebase Step rewrites the branch), only to
  `harmonic/task-<id>`; deny tags, deletes, any other ref and every forge API
  call.
- **Checkpoint after every step.** The engine pushes the Ticket branch to the
  remote through the proxy after each step.

### Secrets and credentials

- **Secrets are injected at runtime** as a per-pod Kubernetes Secret, deleted
  with the pod.
- **Claude subscriptions** work through a long-lived OAuth token
  (`claude setup-token`) stored as an ADR-0046 Secret. Other Harnesses use API
  keys the same way.
- **Credentials baked into an image are refused.**

### Base branch and Merge

- **The remote becomes the base branch's source of truth.** A Workspace that
  uses any Kubernetes target requires a Code Repository (ADR-0046).
- **Merge still happens in Harmonic**, under the one merge policy
  (ADR-0001, ADR-0040): Harmonic fetches the Ticket branch, merges, and then
  pushes the base branch.

### Lost pods

- **A pod lost mid-step is an infrastructure failure**, not a failed Attempt.
  Harmonic starts a fresh pod from the last checkpoint and re-runs the
  interrupted step once.
- **A second loss escalates** as permanent infrastructure failure (Escalation
  reason 3, ADR-0002).
- **A lost warm Session continues cold.**

### Transcripts and Usage

- The Harness's session files stream back live over the API attach and are
  copied out in full at step end, before the pod is deleted. The Ticket page,
  Cost (ADR-0008) and the Archive (ADR-0044) do not depend on the target.

### Images

- Each target has a default image containing the Harnesses. A workflow or a
  step can override it with `image:`.
- Harmonic's release process publishes a base image with all four Harnesses
  as `ghcr.io/mintopia/harmonic-harnesses:<harmonic version>`.

### Concurrency

- **Each Kubernetes target has its own concurrency limit**, separate from the
  Host Ceiling, which bounds `local` only.
- **The Auto-Runner picks a Ticket only when its target has room.** A waiting
  Ticket stays `ready` and shows "waiting for <target>".

### Isolation Mode

- **`direct` is incompatible with Kubernetes.** A workflow that uses a
  Kubernetes target is refused at save if a Workspace using it runs `direct`;
  assigning it to a `direct` Ticket is refused with the reason.

## Considered Options

- **A git sidecar in every pod.** Rejected in favour of one proxy per cluster:
  a sidecar puts the real credentials in every pod's network namespace, and
  each pod would need its own copy of them.
- **Pods dial back to Harmonic over a websocket.** Rejected in favour of API
  attach: dial-back needs an in-pod agent and a listening endpoint on
  Harmonic reachable from the cluster. API attach needs neither and keeps
  Harmonic the only controller.
- **Pod per Ticket only, or pod per step only.** Both kept: a pod per Ticket
  keeps the warm Session, and a pod per step gives each step a clean
  environment. The workflow chooses with `runs_on` at either level.
- **Give pods the Code Repository credentials directly.** Rejected: an agent
  with tool access could push any ref, delete branches or call the forge API.
- **Stateful pass tokens tracked by Harmonic.** Rejected: a signed stateless
  pass needs no shared store between Harmonic and the proxy, and key rotation
  revokes all passes.
- **Merge inside the pod.** Rejected: the one merge policy and its repository
  mutex (ADR-0040) live in Harmonic.
- **Count a lost pod as a failed Attempt.** Rejected: losing a pod says nothing
  about the work. One re-run is enough to tell a blip from a broken cluster.
- **Share the Host Ceiling across targets.** Rejected: the Host Ceiling
  measures the Harmonic host's capacity, which pods do not use.
- **Bake Harness credentials into images.** Rejected: images are shareable
  artefacts and credentials in them outlive any rotation.
- **Forbid mixing `local` and Kubernetes steps in v1.** Rejected: the
  checkpoint push already puts the Ticket branch on the remote after every
  step, so any target can pick it up.

## Consequences

- ADR-0001's ceiling becomes one controlling Node process, with repositories
  local or remote. The merge policy, the repository mutex and the single
  controller are unchanged.
- A Workspace on Kubernetes depends on its Code Repository being reachable
  from both Harmonic and the proxy; there is no Kubernetes execution without a
  remote.
- Every step costs a push. Step-level `runs_on` also costs a cold Session per
  agent step.
- Operators apply the proxy manifest per cluster and keep the signing key
  shared between it and Harmonic.
- The release process gains an image build and push per Harmonic version.
- A `local` step that follows a Kubernetes step works from the fetched Ticket
  branch, so the `local` worktree tracks the remote for that Ticket.
- The Ticket page, Cost and Archive behave the same on every target.
- A `direct` Workspace cannot use Kubernetes targets.

## Supersedes

None. Amends ADR-0001's "Scope and design ceiling" clause (one Node process
against local repositories): execution may now run in Kubernetes pods, with
the remote as the base branch's source of truth for those Workspaces.
