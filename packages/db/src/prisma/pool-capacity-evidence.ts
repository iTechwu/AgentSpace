import { Client } from "pg";
import { resolvePostgresDatabaseUrl } from "../postgres-config.ts";
import { resolveDofePrismaPoolConfig, type DofePrismaProcessRole } from "./prisma-client.ts";

export interface PrismaPoolCapacityEvidenceRole {
  role: Exclude<DofePrismaProcessRole, "default">;
  applicationName: string;
  configuredPoolMax: number;
  observedConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitingConnections: number;
}

export interface PrismaPoolCapacityEvidence {
  capturedAt: string;
  databaseApplicationPrefix: string;
  roles: PrismaPoolCapacityEvidenceRole[];
}

export async function collectPrismaPoolCapacityEvidence(input: {
  env?: NodeJS.ProcessEnv;
  databaseUrl?: string;
  query?: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
} = {}): Promise<PrismaPoolCapacityEvidence> {
  const env = input.env ?? process.env;
  const query = input.query ?? createQuery(resolvePostgresDatabaseUrl({ databaseUrl: input.databaseUrl, env }));
  const rows = await query(`
    SELECT application_name,
           state,
           CASE WHEN wait_event_type IS NULL THEN false ELSE true END AS waiting,
           COUNT(*)::int AS count
      FROM pg_stat_activity
     WHERE application_name LIKE 'agentspace-web%'
        OR application_name LIKE 'agentspace-worker%'
        OR application_name LIKE 'agentspace-daemon%'
     GROUP BY application_name, state, waiting
  `);
  const roles = (["web", "worker", "daemon"] as const).map((role) => {
    const roleEnv: NodeJS.ProcessEnv = { ...env, DOFE_AGENT_PROCESS_ROLE: role };
    if (env.DOFE_AGENT_PROCESS_ROLE !== role) {
      delete roleEnv.DOFE_AGENT_PRISMA_APPLICATION_NAME;
    }
    const config = resolveDofePrismaPoolConfig(roleEnv);
    const matching = rows.rows.filter((row) => String(row.application_name ?? "") === config.application_name);
    const activeConnections = sum(matching, (row) => row.state === "active");
    const idleConnections = sum(matching, (row) => row.state === "idle");
    const waitingConnections = sum(matching, (row) => row.waiting === true || row.waiting === "true");
    return {
      role,
      applicationName: config.application_name,
      configuredPoolMax: config.max,
      observedConnections: activeConnections + idleConnections,
      activeConnections,
      idleConnections,
      waitingConnections,
    } satisfies PrismaPoolCapacityEvidenceRole;
  });
  return {
    capturedAt: new Date().toISOString(),
    databaseApplicationPrefix: "agentspace-",
    roles,
  };
}

function createQuery(databaseUrl: string): (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> {
  const client = new Client({ connectionString: databaseUrl });
  let connected = false;
  return async (sql) => {
    if (!connected) {
      await client.connect();
      connected = true;
    }
    const result = await client.query(sql);
    await client.end();
    connected = false;
    return { rows: result.rows as Array<Record<string, unknown>> };
  };
}

function sum(rows: Array<Record<string, unknown>>, predicate: (row: Record<string, unknown>) => boolean): number {
  return rows.reduce((total, row) => predicate(row) ? total + Number(row.count ?? 0) : total, 0);
}
