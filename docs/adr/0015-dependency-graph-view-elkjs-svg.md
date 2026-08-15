# Dependency graph view: elkjs layered layout + hand-rolled SVG

We're adding a read-only **Graph** view (a new rail View, workspace-scoped) that
renders the board's Tasks as a directed acyclic graph over their Dependency
edges. Layout is the hard part, so we compute node positions with **elkjs**
(layered / Sugiyama layout) and draw the result as **hand-rolled SVG** — matching
the existing `CostChart` precedent and keeping the Aurora visual language under
our own control rather than adopting a canvas library's chrome.

## Considered options

- **React Flow (rejected).** A full interactive node canvas, but it ships its own
  interaction model and visual style we'd spend effort fighting against Aurora,
  and v1 only needs read-only rendering.
- **Fully hand-rolled, including layout (rejected).** Layered DAG layout — layer
  assignment plus crossing minimisation — is not worth reimplementing.
- **elkjs for layout + hand-rolled SVG (chosen).**

## Consequences

- **elkjs** becomes a new web dependency (layout only; rendering stays ours).
- **Zero backend work.** The view reads the existing `GET /tasks` and the
  `task_changed` firehose — every Task already carries `dependsOn` / `dependents`,
  unified across native and mirrored origins.
- **v1 is read-only.** Mirrored edges are tracker-owned and un-editable anyway;
  native-edge editing already lives in Task detail, where a node click deep-links.
- Active-state Tasks show by default with a toggle to reveal terminal
  (completed / cancelled) ones. Map membership is expressed as a **layout
  grouping** (shared `mapRef` → positioned together), not a drawn container.
- The concrete visuals (layout direction, node styling, how grouping reads) are
  settled in a prototype round before build.
