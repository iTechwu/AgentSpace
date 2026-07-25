import { readEffectiveRuntimeEnv } from "./repository-env.ts";

export interface PostgresConnectionInput {
  databaseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolvePostgresDatabaseUrl(input?: PostgresConnectionInput): string {
  const rawEnv = input?.env ?? process.env;
  const env = input?.env ? readEffectiveRuntimeEnv({ env: input.env, repositoryOverridesEnv: false }) : readEffectiveRuntimeEnv();
  const databaseUrl =
    input?.databaseUrl?.trim()
    || rawEnv.DOFE_AGENT_TEST_DATABASE_URL?.trim()
    || rawEnv.DOFE_AGENT_PG_TEST_URL?.trim()
    || env.DOFE_AGENT_TEST_DATABASE_URL?.trim()
    || env.DOFE_AGENT_PG_TEST_URL?.trim()
    || rawEnv.SELF_HOSTED_DATABASE_URL?.trim()
    || rawEnv.DOFE_AGENT_PG_URL?.trim()
    || rawEnv.DATABASE_URL?.trim()
    || env.SELF_HOSTED_DATABASE_URL?.trim()
    || env.DOFE_AGENT_PG_URL?.trim()
    || env.DATABASE_URL?.trim()
    || "";

  if (!databaseUrl) {
    throw new Error(
      "PostgreSQL database URL is required. Set SELF_HOSTED_DATABASE_URL, DOFE_AGENT_PG_URL, or DATABASE_URL.",
    );
  }

  assertSafeTestDatabaseUrl(databaseUrl, env);

  return databaseUrl;
}

export function resolvePostgresDirectDatabaseUrl(input?: PostgresConnectionInput): string | undefined {
  const rawEnv = input?.env ?? process.env;
  const env = input?.env ? readEffectiveRuntimeEnv({ env: input.env, repositoryOverridesEnv: false }) : readEffectiveRuntimeEnv();
  return (
    rawEnv.SELF_HOSTED_DATABASE_DIRECT_URL?.trim()
    || rawEnv.DATABASE_DIRECT_URL?.trim()
    || env.SELF_HOSTED_DATABASE_DIRECT_URL?.trim()
    || env.DATABASE_DIRECT_URL?.trim()
    || undefined
  );
}

export function redactPostgresDatabaseUrl(databaseUrl: string): string {
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return databaseUrl.replace(/:[^:@/]+@/, ":***@");
  }
}

function assertSafeTestDatabaseUrl(databaseUrl: string, env: NodeJS.ProcessEnv): void {
  if (!isTestProcess(env) || env.DOFE_AGENT_ALLOW_PRODUCTION_TEST_DB === "1") {
    return;
  }

  if (looksLikeTestDatabaseUrl(databaseUrl)) {
    return;
  }

  throw new Error(
    "Refusing to use a non-test PostgreSQL database while running tests. "
    + "Set DOFE_AGENT_TEST_DATABASE_URL or DOFE_AGENT_PG_TEST_URL to an isolated test database, "
    + "or set DOFE_AGENT_ALLOW_PRODUCTION_TEST_DB=1 if this is intentional.",
  );
}

function isTestProcess(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.NODE_TEST_CONTEXT
    || env.DOFE_AGENT_E2E === "1"
    || env.VITEST
    || env.JEST_WORKER_ID
    || env.NODE_ENV === "test"
    || process.argv.some((arg) => arg === "--test" || arg.startsWith("--test-")),
  );
}

function looksLikeTestDatabaseUrl(databaseUrl: string): boolean {
  try {
    const parsed = new URL(databaseUrl);
    return /(^|[_-])(test|e2e|loadtest)([_-]|$)/i.test(parsed.pathname.replace(/^\//, ""));
  } catch {
    return /(^|[_-])(test|e2e|loadtest)([_-]|$)/i.test(databaseUrl);
  }
}
