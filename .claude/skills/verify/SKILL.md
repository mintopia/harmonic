---
name: verify
description: Build, launch, and drive AgentDeck to verify changes end-to-end at the web UI or API surface.
---

# Verifying AgentDeck changes

## Build + launch

```bash
npx tsc -p tsconfig.json                      # server → dist/
npx vite build --config web/vite.config.ts    # SPA → dist/web (served by the server)
node dist/cli.js serve --data-dir <tmp-dir> --port 47421 --password verify-pass
```

First run against an empty `--data-dir` needs `--password`; login is
username `operator` + that password. The server serves the built SPA
itself — no vite dev server needed.

## Driving the UI

No Playwright in the repo, but the CLI + chromium browsers exist on this
machine. Write a CJS script and run it with the npx cache on NODE_PATH:

```bash
NODE_PATH=$(ls -d ~/.npm/_npx/*/node_modules/playwright | head -1 | xargs dirname) node drive.cjs
```

Login flow in a fresh context: fill `input[type="password"]`, optional
`input[type="text"]` username, click `button[type="submit"]`, then
`waitForSelector('aside')`.

## Gotchas

- Every fresh browser context lands on Login — log in before waiting
  for app chrome.
- Desktop rail styles are gated behind the 900px `rail:` breakpoint;
  use a ≥1280px viewport for desktop checks, <900px for the drawer.
- Themes follow `prefers-color-scheme`: pass `colorScheme: 'light' | 'dark'`
  (and `reducedMotion: 'reduce'`) as Playwright context options.
