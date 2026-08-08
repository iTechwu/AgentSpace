# Schema drift gate — Phase 0 baseline

The drift gate compares the live database (datasource from `prisma.config.ts`)
against `schema.prisma`:

```bash
pnpm db:prisma:diff
# = prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
```

Exit codes: `0` = no drift, `1` = error, `2` = drift present.

## Baseline result (agent_space_test, schema v116)

```bash
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
| Expression indexes (COALESCE keys) | 2 | raw SQL in `0_init` |
| NULLS-ordering indexes (`NULLS FIRST`) | 1 | raw SQL in `0_init` (drop + recreate, Part C) |
| `CREATE INDEX CONCURRENTLY` | 2 | represented as plain indexes in Part B (CONCURRENTLY needs an empty transaction; on a fresh DB Prisma emits them as plain `CREATE INDEX`, which is equivalent structure) |
| CHECK constraints (TEXT+CHECK enums + shape guards) | 16 | raw SQL in `0_init` |
| Redundant UNIQUE constraint (Prisma-deduped) | 1 | raw SQL in `0_init` (Part C) |

The advisory locks 115/116/117 are application-level only and have no SQL in migrations.

## Trigger reconciliation note

`postgres-schema.ts` declares exactly 5 triggers; live introspection via `pg_trigger`
also reports exactly 5. The two counts match; no reconciliation gap remains. If a future
`db pull` surfaces additional triggers, reconcile here before extending the baseline.

## NULLS FIRST index note

`idx_workflow_node_run_approval_scan` uses `approval_scan_after NULLS FIRST`. Prisma
cannot represent `NULLS FIRST/LAST` on index columns, so `db pull` dropped it and Part B
of the baseline emits the index with the default (`NULLS LAST`). Because the drift gate
introspects and re-normalizes symmetrically, this divergence is **invisible to the drift
gate**. To keep the baseline byte-faithful, Part C drops the Prisma-emitted index and
recreates it with `NULLS FIRST`. If `db pull` ever surfaces more NULLS-ordering indexes,
extend the Part C correction block.

## Redundant UNIQUE constraint note

v116 enforces `workspace.slug` uniqueness **twice**: a UNIQUE constraint
`workspace_slug_key` (backing index of the same name) plus a standalone unique index
`idx_workspace_slug` — historical redundancy from the hand-written schema. Prisma
represents both as a single `@@unique` and cannot round-trip the second enforcement;
the drift gate (symmetric dedup) does not see the loss. Part C re-adds the
`workspace_slug_key` constraint so the baseline matches v116 byte-for-byte. Both
enforcements are functionally identical, so this is cosmetic faithfulness, not a
behavior fix.
