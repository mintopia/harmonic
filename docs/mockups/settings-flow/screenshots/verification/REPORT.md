# Verification (#965)

Built app driven with Playwright. Global and Workspace scope, 1440px and 390px, light and dark, every tab and step (172 shots, `<scope>-<tab>-<step>-<width>-<scheme>.png`). Artboards screenshotted at 1440 and paired in `pair-<Artboard>.png` (artboard left, built right, Global, light). Workflows library, editor Blocks/YAML/Variables also captured.
Notes: Global Integrations has no Code/Work step and Prompts Edit/Impact need a selected prompt, so those URLs fall back to the first step by design; Workspace shots exist for code/work and a prompt was clicked for Edit/Impact at Global.

| Check | Result | Note |
| --- | --- | --- |
| Tabs General, Running Tickets, Prompts, Integrations, Archive & Export; no Security | match | live tab bar |
| Rail switches content, done/current, Back/Next, URL per step | match | all steps, both scopes (Workspace Prompts: defect #967) |
| Rail sticky, stacks at 390px | match | `StepRail` md:sticky; 390 shots stack |
| Resolution strips present, live | match | Workflow, Agent, Archive strips reflect settings |
| Classifier cards at Global | defect | #968 |
| Global Integrations Code/Work | defect | #969 |
| Limits toggles/units/layout | defect | #970 |
| Where Note wrapping | defect | #971 |
| No max-width caps on intros | match | Workflows library intro fixed in this change |
| Prompts Edit preview pane | defect | #972 |
| Workflows library and editor (YAML tab, live diagram, Variables) | match | pair-Library, pair-Editor |
| Prompts keep #902 errors | not exercised | needs invalid-save drive |
| impeccable detect | pass | 3 findings repo-wide, none in settings/workflow/prompt files |
| axe wcag2a/aa | defect | #973 (baseline not measured) |
| Keyboard path through every rail | match | Tab+Enter reaches every step; Workspace Prompts unreachable (#967) |
| Every pre-existing setting reachable | defect | epicPreMergeCommands/Critics have no control (#974) |
