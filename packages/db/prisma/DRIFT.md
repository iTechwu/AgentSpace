# Schema drift gate — Phase 0 baseline

The drift gate compares the live database (datasource from `prisma.config.ts`)
against `schema.prisma`:

```
pnpm db:prisma:diff
# = prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
```

Exit codes: `0` = no drift, `1` = error, `2` = drift present.

## Baseline result (agent_space_test, schema v116)

```
$ prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
No difference detected.            # exit 0
```

`schema.prisma` is a faithful, drift-free representation of the declarable schema.

## Known allowlist — objects Prisma cannot represent

These objects exist in the database but are deliberately absent from `schema.prisma`
(Prisma has no syntax for them). They are NOT drift; they are managed as raw SQL inside
`prisma/migrations/0_init/migration.sql`. Prisma's `migrate diff` ignores triggers and
functions; expression indexes and CHECK constraints are flagged at introspection but do
not appear as drift in the diff.

| Category | Count | Owner |
| --- | ---: | --- |
| Triggers | 5 | raw SQL in `0_init` |
| plpgsql functions | 5 | raw SQL in `0_init` |
| Extension `pgcrypto` | 1 | raw SQL in `0_init` |
| Expression indexes (COALESCE keys) | 3 | raw SQL in `0_init` |
| `CREATE INDEX CONCURRENTLY` | 2 | raw SQL in `0_init` (outside transaction) |
| CHECK constraints (TEXT+CHECK enums) | ~13 | raw SQL in `0_init` |

The advisory locks 115/116/117 are application-level only and have no SQL in migrations.

## Trigger reconciliation note

`postgres-schema.ts` declares exactly 5 triggers; the live DB introspection reported 8
at first count. The 5 declared in source are authoritative for the baseline. If a future
`db pull` surfaces additional triggers, reconcile here before extending the baseline.
