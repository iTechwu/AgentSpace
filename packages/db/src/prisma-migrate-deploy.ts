// Bootstrap-aware entry point for `prisma migrate deploy`.
//
// Phase 1 replaces the boot-time self-migration (ensureRuntimeSchema's slow
// path) with `prisma migrate deploy` run as a discrete deploy step. The wrinkle
// is the production bootstrap: an existing database has the full v116 schema
// (created by the legacy self-migration) but NO `_prisma_migrations` table. A
// naive `prisma migrate deploy` would try to APPLY `0_init`, whose Part B is
// Prisma-generated `CREATE TABLE` (no IF NOT EXISTS) and would fail on
// "relation already exists". And `prisma migrate resolve --applied 0_init`
// cannot be run unconditionally — it throws P3008 when 0_init is already
// recorded.
//
// This wrapper inspects the database once and chooses the right action:
//
//   already-applied      _prisma_migrations has finished 0_init → deploy only.
//   legacy-at-baseline   app_metadata.schema_version == 116, no
//                        _prisma_migrations → `resolve --applied 0_init`
//                        (record without re-running SQL) then deploy.
//   fresh                neither present → deploy applies 0_init for real,
//                        then seed app_metadata.schema_version so the runtime
//                        forward-guard (see ensureRuntimeSchema) treats the
//                        schema as current.
//   anything else        refuse with a clear message (operator must reconcile).
//
// The URL is resolved exactly as the application does
// (resolvePostgresDatabaseUrl: SELF_HOSTED_DATABASE_URL > DOFE_AGENT_PG_URL >
// DATABASE_URL) and forwarded to the Prisma child as DATABASE_URL, so the
// wrapper's inspection connection and Prisma's migrate target are guaranteed
// to be the same database regardless of ambient env. `prisma.config.ts` keeps
// reading DATABASE_URL (default ""), so the drift gate and `prisma generate`
// are unaffected.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { redactPostgresDatabaseUrl, resolvePostgresDatabaseUrl } from "./postgres.ts";
import { POSTGRES_SCHEMA_VERSION } from "./postgres-schema.ts";

const BASELINE_MIGRATION = "0_init";

interface ParsedFlags {
  databaseUrl?: string;
  schema?: string;
}

function parseFlags(argv: string[]): ParsedFlags {
  const flags: ParsedFlags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (key === "database-url" && typeof next === "string") {
      flags.databaseUrl = next;
      index += 1;
    } else if (key === "schema" && typeof next === "string") {
      flags.schema = next;
      index += 1;
    }
  }
  return flags;
}

/** Resolve the Prisma CLI binary, preferring the workspace-installed one. */
function resolvePrismaBin(): string {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = scriptDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, "node_modules", ".bin", "prisma");
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return "prisma";
}

/** Directory that owns prisma.config.ts / prisma/schema.prisma (the @dofe-agent/db package root). */
function resolvePackageDir(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

function runPrisma(
  bin: string,
  packageDir: string,
  args: string[],
  databaseUrl: string,
  schema?: string,
): void {
  const finalArgs = [...args];
  if (schema) {
    finalArgs.push("--schema", schema);
  }
  // Run Prisma from the package dir so it finds prisma.config.ts / migrations,
  // regardless of where this wrapper was invoked from (e.g. Compose WORKDIR).
  // DATABASE_URL is forwarded so Prisma targets the same DB we inspected.
  const result = spawnSync(bin, finalArgs, {
    cwd: packageDir,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`\`prisma ${args.join(" ")}\` exited with status ${String(result.status)}.`);
  }
}

type BootstrapState =
  | { kind: "fresh" }
  | { kind: "legacy-at-baseline" }
  | { kind: "already-applied" };

async function assessBootstrap(client: Client): Promise<BootstrapState> {
  const migrationsTable = await client.query<{ exists: string | null }>(
    `SELECT to_regclass('public._prisma_migrations') AS exists`,
  );
  if (migrationsTable.rows[0]?.exists) {
    const baseline = await client.query<{ finished_at: Date | null }>(
      `SELECT finished_at FROM _prisma_migrations WHERE migration_name = $1`,
      [BASELINE_MIGRATION],
    );
    const row = baseline.rows[0];
    if (row && row.finished_at) {
      return { kind: "already-applied" };
    }
    throw new Error(
      row
        ? `Migration ${BASELINE_MIGRATION} is recorded in _prisma_migrations but finished_at is NULL (it failed or was interrupted). Inspect the database and run \`prisma migrate resolve\` manually.`
        : `_prisma_migrations table exists without the ${BASELINE_MIGRATION} baseline. This is unexpected; inspect the database before proceeding.`,
    );
  }

  // No _prisma_migrations table — is the legacy self-migrated schema present?
  const appMetadataTable = await client.query<{ exists: string | null }>(
    `SELECT to_regclass('public.app_metadata') AS exists`,
  );
  if (!appMetadataTable.rows[0]?.exists) {
    return { kind: "fresh" };
  }

  const versionRow = await client.query<{ value: string | null }>(
    `SELECT value FROM app_metadata WHERE key = 'schema_version' LIMIT 1`,
  );
  const version = versionRow.rows[0]?.value ?? null;
  if (version === POSTGRES_SCHEMA_VERSION) {
    return { kind: "legacy-at-baseline" };
  }
  const numeric = version === null ? NaN : Number.parseInt(version, 10);
  const baselineNumeric = Number.parseInt(POSTGRES_SCHEMA_VERSION, 10);
  const hint =
    Number.isFinite(numeric) && numeric < baselineNumeric
      ? `Run the legacy self-migration (\`node --experimental-strip-types packages/db/src/postgres-cli.ts init\`) to bring the database to version ${POSTGRES_SCHEMA_VERSION} before the Prisma takeover.`
      : `Resolve the version mismatch manually before running Prisma migrations.`;
  throw new Error(
    `Database app_metadata.schema_version is ${JSON.stringify(version)} but the ${BASELINE_MIGRATION} baseline represents version ${POSTGRES_SCHEMA_VERSION}. ${hint}`,
  );
}

/** On a fresh DB, seed the version marker the runtime forward-guard reads. */
async function seedFreshSchemaVersion(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app_metadata (key, value)
       VALUES ('schema_version', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [POSTGRES_SCHEMA_VERSION],
    );
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const databaseUrl = resolvePostgresDatabaseUrl(
    flags.databaseUrl ? { databaseUrl: flags.databaseUrl } : undefined,
  );
  const bin = resolvePrismaBin();
  const packageDir = resolvePackageDir();

  console.log(`[prisma-migrate-deploy] target database: ${redactPostgresDatabaseUrl(databaseUrl)}`);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  let state: BootstrapState;
  try {
    state = await assessBootstrap(client);
  } finally {
    await client.end();
  }

  switch (state.kind) {
    case "already-applied":
      console.log(`[prisma-migrate-deploy] ${BASELINE_MIGRATION} already applied; running migrate deploy.`);
      break;
    case "legacy-at-baseline":
      console.log(
        `[prisma-migrate-deploy] legacy schema at version ${POSTGRES_SCHEMA_VERSION} detected; ` +
          `marking ${BASELINE_MIGRATION} as applied (no SQL re-run), then deploying.`,
      );
      runPrisma(bin, packageDir, ["migrate", "resolve", "--applied", BASELINE_MIGRATION], databaseUrl, flags.schema);
      break;
    case "fresh":
      console.log(`[prisma-migrate-deploy] fresh database; migrate deploy will apply ${BASELINE_MIGRATION}.`);
      break;
  }

  runPrisma(bin, packageDir, ["migrate", "deploy"], databaseUrl, flags.schema);

  if (state.kind === "fresh") {
    await seedFreshSchemaVersion(databaseUrl);
    console.log(
      `[prisma-migrate-deploy] seeded app_metadata.schema_version=${POSTGRES_SCHEMA_VERSION} (runtime forward-guard marker).`,
    );
  }

  console.log("[prisma-migrate-deploy] done.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
