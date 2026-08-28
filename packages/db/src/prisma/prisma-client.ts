import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import { assertPrismaCutoverFlagsValid } from "./cutover-flags.ts";

let sharedClient: PrismaClient | null = null;
let injectedClient: PrismaClient | null = null;

export type DofePrismaProcessRole = "web" | "worker" | "daemon" | "default";

export interface DofePrismaPoolConfig {
  max: number;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  statement_timeout: number;
  application_name: string;
}

const DEFAULT_POOL_MAX: Record<DofePrismaProcessRole, number> = {
  web: 10,
  worker: 5,
  daemon: 3,
  default: 5,
};

type PrismaShutdownEvent = "beforeExit" | "SIGINT" | "SIGTERM";

export interface PrismaShutdownSignalSource {
  once(event: PrismaShutdownEvent, listener: () => void): unknown;
  off(event: PrismaShutdownEvent, listener: () => void): unknown;
}

export interface RegisterDofePrismaShutdownHooksOptions {
  signalSource?: PrismaShutdownSignalSource;
  disconnect?: () => Promise<void>;
  onError?: (error: unknown) => void;
}

export function getDofePrismaClient(): PrismaClient {
  assertPrismaCutoverFlagsValid();
  if (injectedClient) {
    return injectedClient;
  }
  if (!sharedClient) {
    const adapter = new PrismaPg({
      connectionString: withUtcSessionTimezone(resolvePostgresDatabaseUrl()),
      ...resolveDofePrismaPoolConfig(),
    });
    sharedClient = new PrismaClient({ adapter });
  }
  return sharedClient;
}

/**
 * Resolve bounded pool settings once per process. The adapter accepts pg's
 * PoolConfig, so these values apply to every Prisma connection in this role.
 */
export function resolveDofePrismaPoolConfig(
  env: NodeJS.ProcessEnv = process.env,
): DofePrismaPoolConfig {
  const role = parseProcessRole(env.DOFE_AGENT_PROCESS_ROLE);
  return {
    max: readBoundedInteger(env.DOFE_AGENT_PRISMA_POOL_MAX, DEFAULT_POOL_MAX[role], 1, 100),
    connectionTimeoutMillis: readBoundedInteger(env.DOFE_AGENT_PRISMA_CONNECTION_TIMEOUT_MS, 5_000, 100, 120_000),
    idleTimeoutMillis: readBoundedInteger(env.DOFE_AGENT_PRISMA_IDLE_TIMEOUT_MS, 30_000, 1_000, 600_000),
    statement_timeout: readBoundedInteger(env.DOFE_AGENT_PRISMA_STATEMENT_TIMEOUT_MS, 30_000, 100, 600_000),
    application_name: readApplicationName(env.DOFE_AGENT_PRISMA_APPLICATION_NAME, role),
  };
}

function parseProcessRole(value: string | undefined): DofePrismaProcessRole {
  return value === "web" || value === "worker" || value === "daemon" ? value : "default";
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function readApplicationName(value: string | undefined, role: DofePrismaProcessRole): string {
  const normalized = value?.trim().replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 63);
  return normalized || `agentspace-${role}`;
}

function withUtcSessionTimezone(databaseUrl: string): string {
  const parsed = new URL(databaseUrl);
  const existingOptions = parsed.searchParams.get("options")?.trim();
  parsed.searchParams.set(
    "options",
    [existingOptions, "-c timezone=UTC"].filter(Boolean).join(" "),
  );
  return parsed.toString();
}

export function setDofePrismaClientForTests(client: PrismaClient | null): void {
  injectedClient = client;
}

export async function disconnectDofePrismaClient(): Promise<void> {
  injectedClient = null;
  const client = sharedClient;
  sharedClient = null;
  if (client) {
    await client.$disconnect();
  }
}

export function registerDofePrismaShutdownHooks(
  options: RegisterDofePrismaShutdownHooksOptions = {},
): () => void {
  const signalSource = options.signalSource ?? process;
  const disconnect = options.disconnect ?? disconnectDofePrismaClient;
  const onError = options.onError ?? ((error: unknown) => {
    console.error("Failed to disconnect Prisma Client during shutdown.", error);
  });
  let closing = false;
  const events: PrismaShutdownEvent[] = ["beforeExit", "SIGINT", "SIGTERM"];
  const unregister = (): void => {
    for (const event of events) {
      signalSource.off(event, close);
    }
  };
  const close = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    unregister();
    void disconnect().catch(onError);
  };
  for (const event of events) {
    signalSource.once(event, close);
  }
  return unregister;
}
