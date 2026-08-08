import {
  ensurePostgresSchema,
  getDefaultSqliteMigrationPath,
  getPostgresStatus,
  migrateSqliteToPostgres,
  migratePostgresToPostgres,
  redactPostgresDatabaseUrl,
  renderPostgresCutoverPlan,
  resolvePostgresDatabaseUrl,
  type MigrationStatus,
} from "./postgres.ts";

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const [command] = positionals;
  const json = flags.json === true;
  const databaseUrl = getStringFlag(flags, "database-url");
  const sourceDatabaseUrl = getStringFlag(flags, "source-database-url");
  const targetDatabaseUrl = getStringFlag(flags, "target-database-url");
  const sqlitePath = getStringFlag(flags, "sqlite-path");
  const dryRun = flags["dry-run"] === true;
  const reset = flags.reset === true;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "status") {
    const status = await getPostgresStatus({ databaseUrl });
    writeOutput(status, json);
    return;
  }

  if (command === "init") {
    const status = await ensurePostgresSchema({ databaseUrl });
    writeOutput(status, json);
    return;
  }

  if (command === "migrate-from-sqlite") {
    const report = await migrateSqliteToPostgres({
      databaseUrl,
      sqlitePath,
      dryRun,
      reset,
    });
    writeMigrationReport(report, json);
    return;
  }

  if (command === "migrate-from-postgres") {
    const report = await migratePostgresToPostgres({
      sourceDatabaseUrl: sourceDatabaseUrl ?? "",
      targetDatabaseUrl: targetDatabaseUrl ?? databaseUrl ?? resolvePostgresDatabaseUrl(),
      dryRun,
      reset,
    });
    writeMigrationReport(report, json);
    return;
  }

  if (command === "cutover-plan") {
    if (json) {
      writeOutput(
        {
          databaseUrl: databaseUrl ? redactPostgresDatabaseUrl(resolvePostgresDatabaseUrl({ databaseUrl })) : undefined,
          sqlitePath: sqlitePath?.trim() || getDefaultSqliteMigrationPath(),
          plan: renderPostgresCutoverPlan(),
        },
        true,
      );
      return;
    }

    console.log(renderPostgresCutoverPlan());
    return;
  }

  printHelp();
  process.exitCode = 1;
}

function printHelp(): void {
  console.log(`Usage:
  node --experimental-strip-types packages/db/src/postgres-cli.ts status --database-url <postgres-url> [--json]
  node --experimental-strip-types packages/db/src/postgres-cli.ts init --database-url <postgres-url> [--json]
  node --experimental-strip-types packages/db/src/postgres-cli.ts migrate-from-sqlite [--database-url <postgres-url>] [--sqlite-path <sqlite-file>] [--dry-run] [--reset] [--json]
  node --experimental-strip-types packages/db/src/postgres-cli.ts migrate-from-postgres --source-database-url <postgres-url> [--target-database-url <postgres-url>] [--dry-run] [--reset] [--json]
  node --experimental-strip-types packages/db/src/postgres-cli.ts cutover-plan [--database-url <postgres-url>] [--sqlite-path <sqlite-file>] [--json]

Environment:
  SELF_HOSTED_DATABASE_URL
  DOFE_AGENT_PG_URL
  DATABASE_URL

The CLI also auto-loads these values from the repository root .env when present.`);
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const nextToken = args[index + 1];
    if (!nextToken || nextToken.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = nextToken;
    index += 1;
  }

  return { positionals, flags };
}

function getStringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

function writeOutput(payload: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (typeof payload === "string") {
    console.log(payload);
    return;
  }

  console.log(JSON.stringify(payload, null, 2));
}

/**
 * 输出迁移报告并按 status 设置退出码。skipped_incompatible_schema（目标库 schema_version 高于
 * 本实例，已跳过全部语句与数据导入）不是成功——以非零退出码 2 告知 CI/脚本迁移未执行，避免静默成功；
 * completed（含 dry-run 预演通过）保持退出码 0。退出码 2 区别于错误退出码 1（见 main 末尾 catch）。
 */
function writeMigrationReport(report: { status: MigrationStatus }, json: boolean): void {
  writeOutput(report, json);
  if (report.status === "skipped_incompatible_schema") {
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
