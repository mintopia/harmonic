# Settings as a decision flow

Artboards from the design canvas for the settings, Workflows and Prompts
restructure. Each `.dc.html` is one screen. Open it in a browser to see the
layout; `{{name}}` placeholders are values the canvas runtime fills in (for
example `{{x.max}}` is `${{ vars.maxAttempts }}`), and step switching only works
on the canvas.

Light Paper tokens, Global scope, 1440px wide.

| File | Screen |
| --- | --- |
| `Main.dc.html` | Settings › Running Tickets › 1 Workflow |
| `Agent.dc.html` | Settings › Running Tickets › 2 Agent |
| `Where.dc.html` | Settings › Running Tickets › 3 Where |
| `Limits.dc.html` | Settings › Running Tickets › 4 Limits |
| `General.dc.html` | Settings › General (Identity, Access, Chats, Files) |
| `Integrations.dc.html` | Settings › Integrations (Agents, Updates) |
| `Archive.dc.html` | Settings › Archive & Export (Keep, Export, Redact, Deliver) |
| `Prompts.dc.html` | Settings › Prompts › 1 Find (Workspace scope adds step 4, Workspace text) |
| `PromptEdit.dc.html` | Settings › Prompts › 2 Edit and 3 Check impact |
| `Library.dc.html` | Workflows library |
| `Editor.dc.html` | Workflow editor: Blocks / YAML / Variables with the live diagram |

## Pattern rules

- Settings tabs: General · Running Tickets · Prompts · Integrations ·
  Archive & Export. Security folds into General › Access.
- A tab with steps has a left step rail. Selecting a step switches the main
  content; it never scrolls. Back and Next sit at the bottom. The current step
  is teal; earlier steps are green and show their chosen value.
- The rail stays in view while a long step scrolls.
- Where Harmonic resolves something in order (workflow, agent, tracker,
  Archive lifecycle), the step opens with a strip of the rules in order. The
  rule that always matches has a teal border; rules set elsewhere are dashed.
- Intro and description text fills its column. No reading-measure
  `max-width` on short UI copy.
- Sample values in the artboards (budgets, Destinations, Harness rows,
  Model Options) are placeholders. Bind real settings.
