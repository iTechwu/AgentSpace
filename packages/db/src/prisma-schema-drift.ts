import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolvePostgresDatabaseUrl } from "./postgres-config.ts";
import {
  comparePrismaSchemaContract,
  parsePrismaSchemaContract,
  type PostgresSchemaSnapshot,
} from "./prisma/schema-contract.ts";

const schemaPath = fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url));
const contract = parsePrismaSchemaContract(await readFile(schemaPath, "utf8"));
const tableNames = contract.models.map((model) => model.tableName);
const client = new pg.Client({ connectionString: resolvePostgresDatabaseUrl() });

try {
  await client.connect();
  const columns = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: "YES" | "NO";
    column_default: string | null;
  }>(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`,
    [tableNames],
  );
  const primaryKeys = await client.query<{
    table_name: string;
    column_names: string[];
  }>(
    `SELECT relation.relname AS table_name,
            array_agg(attribute.attname::text ORDER BY key_column.ordinality) AS column_names
       FROM pg_constraint AS constraint_record
       JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN LATERAL unnest(constraint_record.conkey)
         WITH ORDINALITY AS key_column(attnum, ordinality) ON true
       JOIN pg_attribute AS attribute
         ON attribute.attrelid = relation.oid
        AND attribute.attnum = key_column.attnum
      WHERE constraint_record.contype = 'p'
        AND namespace.nspname = current_schema()
        AND relation.relname = ANY($1::text[])
      GROUP BY relation.relname`,
    [tableNames],
  );
  const snapshot: PostgresSchemaSnapshot = {
    columns: columns.rows.map((column) => ({
      tableName: column.table_name,
      columnName: column.column_name,
      dataType: column.data_type,
      nullable: column.is_nullable === "YES",
      hasDefault: column.column_default !== null,
    })),
    primaryKeys: new Map(primaryKeys.rows.map((row) => [row.table_name, row.column_names])),
  };
  const drift = comparePrismaSchemaContract(contract, snapshot);
  if (drift.length > 0) {
    console.error("Prisma pilot schema drift detected:");
    for (const finding of drift) console.error(`- ${finding}`);
    process.exitCode = 1;
  } else {
    console.log(`Prisma pilot schema matches PostgreSQL (${contract.models.length} models).`);
  }
} finally {
  await client.end().catch(() => undefined);
}
