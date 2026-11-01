# Verification (#965)

Built app driven with Playwright at 1440px and 390px, light and dark, Global scope. Files: `global-<tab>-<step>-<width>-<scheme>.png`.

| Check | Result | Note |
| --- | --- | --- |
| Tabs General, Running Tickets, Prompts, Integrations, Archive & Export; no Security | match | read from the live tab bar |
| Rail switches content, done/current states, Back/Next | match | spot-checked Workflow and Where steps |
| Rail sticky, stacks at 390px | match | `StepRail` is `md:sticky`; 390px shot stacks it above content |
| Resolution strip (Running Tickets > Workflow) | match | rules in order, "always matches" card teal |
| No max-width caps on intros | defect, fixed | Workflows library intro wrapped at 68ch; now `fill` |
| Workflow editor Blocks / YAML / Variables + diagram | match | all three tabs and SVG diagram present |
| Prompts Find step renders | match | Edit/Impact not exercised |
| `impeccable detect`, axe | not run | tools not installed on this host |
| Workspace scope, full pair-by-pair artboard diff, keyboard path | not done | Global only; no Workspace fixture created |
