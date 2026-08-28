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
  const indexes = await client.query<{
    table_name: string;
    is_unique: boolean;
    column_names: string[];
  }>(
    `SELECT relation.relname AS table_name,
            index_record.indisunique AS is_unique,
            array_agg(attribute.attname::text ORDER BY key_column.ordinality) AS column_names
       FROM pg_index AS index_record
       JOIN pg_class AS relation ON relation.oid = index_record.indrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN LATERAL unnest(index_record.indkey)
         WITH ORDINALITY AS key_column(attnum, ordinality) ON true
       JOIN pg_attribute AS attribute
         ON attribute.attrelid = relation.oid
        AND attribute.attnum = key_column.attnum
      WHERE namespace.nspname = current_schema()
        AND relation.relname = ANY($1::text[])
        AND NOT index_record.indisprimary
      GROUP BY relation.relname, index_record.indexrelid, index_record.indisunique
      ORDER BY relation.relname, index_record.indexrelid`,
    [tableNames],
  );
  const foreignKeys = await client.query<{
    table_name: string;
    column_names: string[];
    referenced_table: string;
    referenced_column_names: string[];
    on_delete: string;
  }>(
    `SELECT relation.relname AS table_name,
            array_agg(local_attribute.attname::text ORDER BY local_key.ordinality) AS column_names,
            referenced_relation.relname AS referenced_table,
            array_agg(referenced_attribute.attname::text ORDER BY local_key.ordinality) AS referenced_column_names,
            CASE constraint_record.confdeltype
              WHEN 'c' THEN 'Cascade'
              WHEN 'n' THEN 'SetNull'
              WHEN 'd' THEN 'SetDefault'
              WHEN 'r' THEN 'Restrict'
              ELSE 'NoAction'
            END AS on_delete
       FROM pg_constraint AS constraint_record
       JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
       JOIN pg_class AS referenced_relation ON referenced_relation.oid = constraint_record.confrelid
       JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       JOIN LATERAL unnest(constraint_record.conkey)
         WITH ORDINALITY AS local_key(attnum, ordinality) ON true
       JOIN LATERAL unnest(constraint_record.confkey)
         WITH ORDINALITY AS referenced_key(attnum, ordinality)
         ON referenced_key.ordinality = local_key.ordinality
       JOIN pg_attribute AS local_attribute
         ON local_attribute.attrelid = relation.oid
        AND local_attribute.attnum = local_key.attnum
       JOIN pg_attribute AS referenced_attribute
         ON referenced_attribute.attrelid = referenced_relation.oid
        AND referenced_attribute.attnum = referenced_key.attnum
      WHERE constraint_record.contype = 'f'
        AND namespace.nspname = current_schema()
        AND relation.relname = ANY($1::text[])
      GROUP BY constraint_record.oid, relation.relname, referenced_relation.relname, constraint_record.confdeltype
      ORDER BY relation.relname, constraint_record.oid`,
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
    indexes: indexes.rows.map((row) => ({
      tableName: row.table_name,
      columns: row.column_names,
      unique: row.is_unique,
    })),
    foreignKeys: foreignKeys.rows.map((row) => ({
      tableName: row.table_name,
      columns: row.column_names,
      referencedTable: row.referenced_table,
      referencedColumns: row.referenced_column_names,
      onDelete: row.on_delete,
    })),
  };
  const drift = comparePrismaSchemaContract(contract, snapshot);
  if (drift.length > 0) {
    console.error("Prisma contract schema drift detected:");
    for (const finding of drift) console.error(`- ${finding}`);
    process.exitCode = 1;
  } else {
    console.log(`Prisma contract schema matches PostgreSQL (${contract.models.length} models).`);
  }
} finally {
  await client.end().catch(() => undefined);
}
