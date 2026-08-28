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
  const indexes = await client.query<{ indexname: string; predicate: string | null }>(
    `SELECT index_class.relname AS indexname,
            pg_get_expr(indpred, indrelid) AS predicate
       FROM pg_index
       JOIN pg_class AS index_class ON index_class.oid = pg_index.indexrelid
       JOIN pg_class AS table_class ON table_class.oid = pg_index.indrelid
       JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
      WHERE table_namespace.nspname = current_schema()`,
  );
  const functions = await client.query<{ proname: string; definition: string }>(`SELECT procedure.proname,
            pg_get_functiondef(procedure.oid) AS definition
      FROM pg_proc AS procedure
      JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = current_schema() AND procedure.prokind IN ('f', 'p')`);
  const triggers = await client.query<{ tgname: string }>(`SELECT trigger_record.tgname
      FROM pg_trigger AS trigger_record
      JOIN pg_class AS relation ON relation.oid = trigger_record.tgrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema() AND NOT trigger_record.tgisinternal`);
  const checkConstraints = await client.query<{ conname: string; definition: string }>(`SELECT constraint_record.conname,
            pg_get_constraintdef(constraint_record.oid) AS definition
      FROM pg_constraint AS constraint_record
      JOIN pg_namespace AS namespace ON namespace.oid = constraint_record.connamespace
      WHERE namespace.nspname = current_schema() AND constraint_record.contype = 'c'`);
  const enums = await client.query<{ name: string; labels: string[] }>(`SELECT type.typname AS name,
            ARRAY_AGG(enum_label.enumlabel ORDER BY enum_label.enumsortorder) AS labels
       FROM pg_type AS type
       JOIN pg_enum AS enum_label ON enum_label.enumtypid = type.oid
       JOIN pg_namespace AS namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = current_schema()
      GROUP BY type.typname`);
  const views = await client.query<{ name: string; definition: string }>(`SELECT table_name AS name,
            pg_get_viewdef(format('%I.%I', table_schema, table_name)::regclass, true) AS definition
       FROM information_schema.views
      WHERE table_schema = current_schema()`);
  const snapshot: PostgresInvariantSnapshot = {
    indexes: indexes.rows.map((row) => row.indexname),
    functions: functions.rows.map((row) => row.proname),
    triggers: triggers.rows.map((row) => row.tgname),
    checkConstraints: checkConstraints.rows.map((row) => row.conname),
    indexPredicates: Object.fromEntries(indexes.rows.flatMap((row) => {
      const name = row.indexname;
      return name && row.predicate ? [[name, row.predicate]] : [];
    })),
    checkDefinitions: Object.fromEntries(checkConstraints.rows.map((row) => [row.conname, row.definition])),
    enumLabels: Object.fromEntries(enums.rows.map((row) => [row.name, row.labels])),
    views: Object.fromEntries(views.rows.map((row) => [row.name, row.definition])),
    functionBodies: Object.fromEntries(functions.rows.map((row) => [row.proname, extractFunctionBody(row.definition)])),
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
        + `checkConstraints=${contract.checkConstraints.length}, predicates=${Object.keys(contract.indexPredicates).length}, `
        + `enums=${Object.keys(contract.enumLabels).length}, views=${Object.keys(contract.views).length}, `
        + `functionBodies=${Object.keys(contract.functionBodies).length}).`,
    );
  }
} finally {
  await client.end().catch(() => undefined);
}

function extractFunctionBody(definition: string): string {
  const match = definition.match(/\bAS\s+\$[^$]*\$([\s\S]*?)\$[^$]*\$/i);
  return match?.[1] ?? definition;
}
