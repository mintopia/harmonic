# Run SQLite migrations with foreign_keys disabled

drizzle table-rebuild migrations (create `__new_x`, copy rows, `DROP TABLE x`,
rename) require foreign-key enforcement to be **off**. SQLite's
`PRAGMA foreign_keys` is a no-op inside a transaction, and drizzle runs each
migration in one — so the `PRAGMA foreign_keys=OFF` the generated migration emits
does nothing. `openDb` used to set `foreign_keys = ON` *before* `migrate()`, so
migration `0019`'s `DROP TABLE tasks` hit `SQLITE_CONSTRAINT_FOREIGNKEY` on any
populated database (child rows in `runs`, `task_dependencies`, and
`conversations` reference the `tasks` rows the drop implicitly deletes) — a hard
boot failure for **every existing database**, while fresh ones passed because
they have no rows to delete.

We now disable foreign keys at the **connection level, before** `migrate()`, run
`PRAGMA foreign_key_check` afterwards to surface any genuine integrity break the
migrations introduced, then enable them for runtime:

```
sqlite.pragma('foreign_keys = OFF');
migrate(db, { migrationsFolder });
sqlite.pragma('foreign_key_check');
sqlite.pragma('foreign_keys = ON');
```

## Consequences

- Any table-rebuild migration is safe under this ordering; new ones need no
  special handling.
- The failed `0019` migration rolls back within its transaction, so affected
  databases are intact at their pre-`0019` state — booting the patched build
  completes the migration cleanly, with no manual repair and no data loss.
- Foreign keys are still enforced at runtime (set `ON` after migrate), so
  application writes get full referential integrity.
- Regression coverage: a migration test seeds a populated pre-`0019` database (a
  Task with a Dependency edge and a Run) and asserts `openDb` succeeds.
