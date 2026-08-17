import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { resolveDofePrismaPoolConfig, type DofePrismaProcessRole } from "./prisma-client.ts";

export interface PrismaPoolCapacityLoadTestInput {
  databaseUrl: string;
  role: Exclude<DofePrismaProcessRole, "default">;
  concurrency?: number;
  holdMs?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  captureConnections?: () => Promise<{ observedConnections: number; activeConnections: number; waitingConnections: number }>;
}

export interface PrismaPoolCapacityLoadTestReport {
  capturedAt: string;
  role: Exclude<DofePrismaProcessRole, "default">;
  applicationName: string;
  configuredPoolMax: number;
  concurrency: number;
  holdMs: number;
  timeoutMs: number;
  completed: number;
  timedOut: number;
  failed: number;
  p95Ms: number | null;
  maxMs: number | null;
  observedConnections: number;
  activeConnections: number;
  waitingConnections: number;
  gracefulShutdownMs: number;
}

/**
 * Run against an isolated database only. The load test deliberately refuses
 * regular dev/prod database names so a copied command cannot saturate a live
 * application pool by accident.
 */
export async function runPrismaPoolCapacityLoadTest(
  input: PrismaPoolCapacityLoadTestInput,
): Promise<PrismaPoolCapacityLoadTestReport> {
  const databaseUrl = validatePrismaPoolLoadTestDatabaseUrl(input.databaseUrl);
  const env = {
    ...process.env,
    ...(input.env ?? {}),
    DOFE_AGENT_PROCESS_ROLE: input.role,
    ...(input.timeoutMs === undefined ? {} : { DOFE_AGENT_PRISMA_STATEMENT_TIMEOUT_MS: String(input.timeoutMs) }),
  };
  const config = resolveDofePrismaPoolConfig(env);
  const concurrency = boundedInteger(input.concurrency, 2, 1, 200);
  const holdMs = boundedInteger(input.holdMs, 250, 1, 30_000);
  const timeoutMs = boundedInteger(input.timeoutMs, config.statement_timeout, 100, 600_000);
  const adapter = new PrismaPg({ connectionString: databaseUrl, ...config });
  const client = new PrismaClient({ adapter });
  const startedAt = Date.now();
  const durations: number[] = [];
  let timedOut = 0;
  let failed = 0;

  try {
    await Promise.all(Array.from({ length: concurrency }, async () => {
      const operationStartedAt = Date.now();
      try {
        await client.$queryRaw(Prisma.sql`SELECT pg_sleep(${holdMs / 1000})`);
        durations.push(Date.now() - operationStartedAt);
      } catch (error) {
        if (isTimeoutError(error) || Date.now() - operationStartedAt >= timeoutMs) timedOut += 1;
        else failed += 1;
      }
    }));
  } finally {
    const shutdownStartedAt = Date.now();
    await client.$disconnect();
    const gracefulShutdownMs = Date.now() - shutdownStartedAt;
    const observed = input.captureConnections
      ? await input.captureConnections()
      : { observedConnections: 0, activeConnections: 0, waitingConnections: 0 };
    return {
      capturedAt: new Date(startedAt).toISOString(),
      role: input.role,
      applicationName: config.application_name,
      configuredPoolMax: config.max,
      concurrency,
      holdMs,
      timeoutMs,
      completed: durations.length,
      timedOut,
      failed,
      p95Ms: percentile95(durations),
      maxMs: durations.length > 0 ? Math.max(...durations) : null,
      ...observed,
      gracefulShutdownMs,
    };
  }
}

export function validatePrismaPoolLoadTestDatabaseUrl(databaseUrl: string): string {
  const normalized = databaseUrl.trim();
  if (!normalized) throw new Error("prisma_pool_loadtest.database_url_required");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("prisma_pool_loadtest.database_url_invalid");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, "")).toLowerCase();
  if (!/(^|[-_])(test|loadtest|ci)([-_]|$)/.test(databaseName)) {
    throw new Error("prisma_pool_loadtest.requires_isolated_database");
  }
  return normalized;
}

export function percentile95(durations: readonly number[]): number | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? null;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value as number));
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return code === "57014" || /timeout|timed out|statement timeout/i.test(message);
}
