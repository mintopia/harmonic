# The documentation site is Astro Starlight, published to GitHub Pages

User-facing documentation lives in a standalone static site built with
**Astro Starlight** under a top-level `website/` directory, published to
**GitHub Pages** by a `.github/workflows` action on push to `main`. The site is
greenfield tooling, since no docs generator existed before, and draws its content
from the markdown the repo already keeps (`README.md`, `CONTEXT.md`,
`PRODUCT.md`, `docs/**`, the ADRs). Its API-reference page is generated from
Harmonic's own OpenAPI spec rather than hand-written: a build-time script builds
the Fastify app in-process and calls `app.swagger()` to emit
`website/src/openapi.json`, so the reference can never drift from the Zod route
schemas (ADR 0005).

We chose Starlight because the audience is two-tracked, a developer-operator
adopting Harmonic and a contributor working on internals, and Starlight gives
search, a sidebar, and a dark-canonical theme out of the box, matching the
Aurora identity (cobalt accent, Space Grotesk + JetBrains Mono) with a
light-touch theme rather than a bespoke build. Keeping the site in its own
`website/` dir and its own Pages workflow decouples docs deploys from the app
release, so prose fixes never wait on a server build.

## Considered options

- **VitePress (rejected).** Vite-native, which pairs with the app's Vite 8
  build, but its Vue theming and thinner OpenAPI story buy less than Starlight's
  docs-first defaults. "Matches the app's stack" earns little when the docs
  build is deliberately separate from the app build.
- **Docusaurus (rejected).** React (matching the app) and MDX-rich, but heavier
  to stand up and theme for what is a content-first site.
- **In-repo markdown only, no site (rejected).** Zero tooling, but no search, no
  navigation, no rendered API reference, and no public URL, and the ask was
  explicitly a documentation *website*.
- **Docs served inside the Harmonic app at `/docs` (rejected).** Couples every
  docs change to an app deploy and bloats the app bundle with prose.
- **Astro Starlight in `website/`, Pages-published (chosen).** Best docs UX for
  the least theming work, isolated from the app, with a first-class OpenAPI
  plugin fed by the in-process spec export.

## Consequences

- A new top-level `website/` holds the site source; existing `docs/**` (ADRs,
  agent guides) stays where it is and becomes a content source, not the site.
- The API reference depends on an `npm run docs:openapi` step that builds the
  app in-process and writes a committed `openapi.json` snapshot, regenerated in
  the Pages workflow before the Starlight build: no running server, no port.
- Docs deploy on their own cadence via GitHub Pages, independent of app
  releases.
- Theming is intentionally light for v1 (accent + fonts + dark default); a full
  `DESIGN.md`-faithful theme, if wanted, is later polish, not a v1 blocker.
- If the API reference or brand needs ever outgrow Starlight's plugins, this ADR
  should be revisited rather than bolting a second generator alongside it.
