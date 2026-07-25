import "@testing-library/jest-dom/vitest";

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

if (typeof window !== "undefined" && typeof window.localStorage?.getItem !== "function") {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      get length() { return values.size; },
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, String(value)),
    } satisfies Storage,
  });
}

const explicitTestDatabaseUrl =
  process.env.DOFE_AGENT_TEST_DATABASE_URL?.trim()
  || process.env.DOFE_AGENT_PG_TEST_URL?.trim()
  || resolveConfiguredTestDatabaseUrl();

if (explicitTestDatabaseUrl) {
  if (!looksLikeTestDatabaseUrl(explicitTestDatabaseUrl)) {
    throw new Error(
      "Refusing to run web tests against an explicit database URL that is not marked as test/e2e. "
      + "Use a database name containing test/e2e.",
    );
  }
  process.env.DOFE_AGENT_PG_URL = explicitTestDatabaseUrl;
  process.env.DATABASE_URL = explicitTestDatabaseUrl;
} else if (process.env.DOFE_AGENT_ALLOW_PRODUCTION_TEST_DB !== "1") {
  const databaseUrl = resolveConfiguredDatabaseUrl();
  if (databaseUrl && !looksLikeTestDatabaseUrl(databaseUrl)) {
    throw new Error(
      "Refusing to run web tests against the configured application database. "
      + "Set DOFE_AGENT_TEST_DATABASE_URL to an isolated PostgreSQL test database, "
      + "or set DOFE_AGENT_ALLOW_PRODUCTION_TEST_DB=1 if this is intentional.",
    );
  }
}

function resolveConfiguredDatabaseUrl(): string | undefined {
  const fromEnv = process.env.SELF_HOSTED_DATABASE_URL?.trim()
    || process.env.DOFE_AGENT_PG_URL?.trim()
    || process.env.DATABASE_URL?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const envFilePath = resolve(process.cwd(), "..", "..", ".env");
  if (!existsSync(envFilePath)) {
    return undefined;
  }

  const parsed = parseDotEnv(readFileSync(envFilePath, "utf8"));
  return parsed.SELF_HOSTED_DATABASE_URL?.trim()
    || parsed.DOFE_AGENT_PG_URL?.trim()
    || parsed.DATABASE_URL?.trim()
    || undefined;
}

function resolveConfiguredTestDatabaseUrl(): string | undefined {
  const envFilePath = resolve(process.cwd(), "..", "..", ".env");
  if (!existsSync(envFilePath)) {
    return undefined;
  }

  const parsed = parseDotEnv(readFileSync(envFilePath, "utf8"));
  return parsed.DOFE_AGENT_TEST_DATABASE_URL?.trim()
    || parsed.DOFE_AGENT_PG_TEST_URL?.trim()
    || undefined;
}

function looksLikeTestDatabaseUrl(databaseUrl: string): boolean {
  try {
    const parsed = new URL(databaseUrl);
    return /(^|[_-])(test|e2e|loadtest)([_-]|$)/i.test(parsed.pathname.replace(/^\//, ""));
  } catch {
    return /(^|[_-])(test|e2e|loadtest)([_-]|$)/i.test(databaseUrl);
  }
}


function parseDotEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).replace(/^export\s+/, "").trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
