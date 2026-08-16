import pg from "pg";
import {
  getPostgresPostCommitSchemaStatements,
  getPostgresSchemaStatements,
} from "./postgres-schema.ts";
import { resolvePostgresDatabaseUrl } from "./postgres-config.ts";
import {
  comparePostgresInvariantContract,
  extractPostgresInvariantContract,
  type PostgresInvariantSnapshot,
} from "./prisma/postgres-invariant-contract.ts";

const client = new pg.Client({ connectionString: resolvePostgresDatabaseUrl() });
const contract = extractPostgresInvariantContract([
  ...getPostgresSchemaStatements(),
  ...getPostgresPostCommitSchemaStatements(),
]);

try {
  await client.connect();
  const indexes = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()`,
  );
  const functions = await client.query<{ proname: string }>(`SELECT procedure.proname
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = current_schema() AND procedure.prokind IN ('f', 'p')`);
  const triggers = await client.query<{ tgname: string }>(`SELECT trigger_record.tgname
      FROM pg_trigger AS trigger_record
      JOIN pg_class AS relation ON relation.oid = trigger_record.tgrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema() AND NOT trigger_record.tgisinternal`);
  const checkConstraints = await client.query<{ conname: string }>(`SELECT constraint_record.conname
      FROM pg_constraint AS constraint_record
      JOIN pg_namespace AS namespace ON namespace.oid = constraint_record.connamespace
      WHERE namespace.nspname = current_schema() AND constraint_record.contype = 'c'`);
  const snapshot: PostgresInvariantSnapshot = {
    indexes: indexes.rows.map((row) => row.indexname),
    functions: functions.rows.map((row) => row.proname),
    triggers: triggers.rows.map((row) => row.tgname),
    checkConstraints: checkConstraints.rows.map((row) => row.conname),
  };
  const drift = comparePostgresInvariantContract(contract, snapshot);
  if (drift.length > 0) {
    console.error("PostgreSQL invariant drift detected:");
    for (const finding of drift) console.error(`- ${finding}`);
    process.exitCode = 1;
  } else {
    console.log(
      `PostgreSQL invariant objects present (indexes=${contract.indexes.length}, `
        + `functions=${contract.functions.length}, triggers=${contract.triggers.length}, `
        + `checkConstraints=${contract.checkConstraints.length}).`,
    );
  }
} finally {
  await client.end().catch(() => undefined);
}
