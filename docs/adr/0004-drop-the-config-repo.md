# Drop the Config Repo

The Config Repo (a dotfiles-style git repository seeding harnesses,
models, prices, channels, credentials, and API keys — imported on
`harmonic init` and explicit pull, exportable back out) is removed from
the product. Setup has become easy enough that a portability layer is
not worth its surface: config is now editable in the web UI, the server
enforces a password at first boot, and `npx github:mintopia/harmonic`
(ADR-0003) already makes a fresh install a one-liner. Machine-to-machine
portability was the Config Repo's only remaining job, and copying the
data directory covers it.

## Consequences

- `src/config-repo.ts`, its routes (`/api/config-repo*`), the
  `harmonic init` CLI command, and the `AuthService`
  export/import plumbing that existed only to serve it are deleted.
- The **Config Repo** term leaves `CONTEXT.md` when the removal lands.
- The database is the sole home of configuration; there is no
  out-of-band seed. Anyone wanting config in git again should
  supersede this ADR rather than resurrect the old mechanism.
