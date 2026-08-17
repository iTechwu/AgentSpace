import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@prisma/client";
import { Client } from "pg";
import { resolveDofePrismaPoolConfig, type DofePrismaProcessRole } from "./prisma-client.ts";

export interface PrismaPoolCapacityLoadTestInput {
  databaseUrl: string;
  role: Exclude<DofePrismaProcessRole, "default">;
  concurrency?: number;
  holdMs?: number;
  /** @deprecated Use statementTimeoutMs. */
  timeoutMs?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
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
  connectionTimeoutMs: number;
  statementTimeoutMs: number;
  /** @deprecated Alias of statementTimeoutMs. */
  timeoutMs: number;
  completed: number;
  timedOut: number;
  connectionTimedOut: number;
  statementTimedOut: number;
  failed: number;
  p95Ms: number | null;
  maxMs: number | null;
  connectionWaitP95Ms: number | null;
  observedConnections: number;
  activeConnections: number;
  waitingConnections: number;
  gracefulShutdownMs: number;
  gracefulShutdownDuringInflight: boolean;
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
    ...((input.statementTimeoutMs ?? input.timeoutMs) === undefined
      ? {}
      : { DOFE_AGENT_PRISMA_STATEMENT_TIMEOUT_MS: String(input.statementTimeoutMs ?? input.timeoutMs) }),
    ...(input.connectionTimeoutMs === undefined ? {} : { DOFE_AGENT_PRISMA_CONNECTION_TIMEOUT_MS: String(input.connectionTimeoutMs) }),
  };
  const config = resolveDofePrismaPoolConfig(env);
  const concurrency = boundedInteger(input.concurrency, 2, 1, 200);
  const holdMs = boundedInteger(input.holdMs, 250, 1, 30_000);
  const statementTimeoutMs = boundedInteger(input.statementTimeoutMs ?? input.timeoutMs, config.statement_timeout, 100, 600_000);
  const connectionTimeoutMs = boundedInteger(input.connectionTimeoutMs, config.connectionTimeoutMillis, 100, 120_000);
  const adapter = new PrismaPg({ connectionString: databaseUrl, ...config });
  const client = new PrismaClient({ adapter });
  const startedAt = Date.now();
  const durations: number[] = [];
  let connectionTimedOut = 0;
  let statementTimedOut = 0;
  let failed = 0;
  let observed = { observedConnections: 0, activeConnections: 0, waitingConnections: 0 };
  let gracefulShutdownMs = 0;
  let gracefulShutdownDuringInflight = false;

  try {
    const operations = Array.from({ length: concurrency }, async () => {
      const operationStartedAt = Date.now();
      try {
        await client.$queryRaw(Prisma.sql`WITH pause AS (SELECT pg_sleep(${holdMs / 1000})) SELECT 1::integer AS completed FROM pause`);
        durations.push(Date.now() - operationStartedAt);
      } catch (error) {
        if (isConnectionTimeoutError(error)) connectionTimedOut += 1;
        else if (isStatementTimeoutError(error)) statementTimedOut += 1;
        else failed += 1;
      }
    });
    const work = Promise.all(operations);
    await waitForInflightQueries(holdMs);
    observed = input.captureConnections
      ? await input.captureConnections()
      : await capturePrismaPoolConnections(databaseUrl, config.application_name);
    await work;

    const shutdown = await measureInflightDisconnect(databaseUrl, config, holdMs);
    gracefulShutdownMs = shutdown.durationMs;
    gracefulShutdownDuringInflight = shutdown.duringInflight;
  } finally {
    await client.$disconnect();
  }
  return {
    capturedAt: new Date(startedAt).toISOString(),
    role: input.role,
    applicationName: config.application_name,
    configuredPoolMax: config.max,
    concurrency,
    holdMs,
    connectionTimeoutMs,
    statementTimeoutMs,
    timeoutMs: statementTimeoutMs,
    completed: durations.length,
    timedOut: connectionTimedOut + statementTimedOut,
    connectionTimedOut,
    statementTimedOut,
    failed,
    p95Ms: percentile95(durations),
    maxMs: durations.length > 0 ? Math.max(...durations) : null,
    connectionWaitP95Ms: percentile95(durations.map((duration) => Math.max(0, duration - holdMs))),
    ...observed,
    gracefulShutdownMs,
    gracefulShutdownDuringInflight,
  };
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

function isStatementTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return code === "57014" || /statement timeout|canceling statement/i.test(message);
}

function isConnectionTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const message = "message" in error ? String(error.message) : "";
  return /connection timeout|timeout acquiring|connect(?:ion)? timed out|timeout exceeded when trying to connect/i.test(message);
}

async function waitForInflightQueries(holdMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.min(50, Math.max(10, Math.floor(holdMs / 4)))));
}

async function capturePrismaPoolConnections(
  databaseUrl: string,
  applicationName: string,
): Promise<{ observedConnections: number; activeConnections: number; waitingConnections: number }> {
  const observer = new Client({ connectionString: databaseUrl });
  await observer.connect();
  try {
    const result = await observer.query<{
      observed_connections: number;
      active_connections: number;
      waiting_connections: number;
    }>(`
      SELECT COUNT(*)::int AS observed_connections,
             COUNT(*) FILTER (WHERE state = 'active')::int AS active_connections,
             COUNT(*) FILTER (WHERE wait_event_type IS NOT NULL)::int AS waiting_connections
        FROM pg_stat_activity
       WHERE application_name = $1
    `, [applicationName]);
    const row = result.rows[0];
    return {
      observedConnections: Number(row?.observed_connections ?? 0),
      activeConnections: Number(row?.active_connections ?? 0),
      waitingConnections: Number(row?.waiting_connections ?? 0),
    };
  } finally {
    await observer.end();
  }
}

async function measureInflightDisconnect(
  databaseUrl: string,
  config: ReturnType<typeof resolveDofePrismaPoolConfig>,
  holdMs: number,
): Promise<{ durationMs: number; duringInflight: boolean }> {
  const adapter = new PrismaPg({ connectionString: databaseUrl, ...config });
  const probe = new PrismaClient({ adapter });
  const probeHoldMs = Math.min(1_000, Math.max(100, holdMs));
  const query = (async () => probe.$queryRaw(
    Prisma.sql`WITH pause AS (SELECT pg_sleep(${probeHoldMs / 1000})) SELECT 1::integer AS completed FROM pause`,
  ))();
  await waitForInflightQueries(probeHoldMs);
  const startedAt = Date.now();
  const disconnect = probe.$disconnect();
  const [queryResult, disconnectResult] = await Promise.allSettled([query, disconnect]);
  if (disconnectResult.status === "rejected") throw disconnectResult.reason;
  return { durationMs: Date.now() - startedAt, duringInflight: queryResult.status === "fulfilled" };
}
