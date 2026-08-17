// 3.5-4：自 remote-daemon.ts 拆出——托管 MCP 连接装配（stdio/managed service）
// 与任务级共享网关池。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { McpManagedStdioLaunch, McpTaskSessionConnection, ResolvedMcpConnection } from "@dofe-agent/domain";
import type { HttpDaemonClient } from "../daemon-client.ts";
import { McpGateway, McpGatewayPool } from "../mcp/gateway.ts";
import type { McpAuditOutbox } from "../mcp/audit-outbox.ts";
import {
  getManagedRuntimeHomeDir,
  resolveManagedRuntimeDockerGateway,
  resolveManagedRuntimeDockerNetwork,
} from "../managed-provider-credentials.ts";
import type { RemoteRuntimeRecord } from "../provider-runtime.ts";
import type { RemoteDaemonConfig } from "./config.ts";
import { buildManagedRuntimeImage } from "../managed-runtime-image.ts";

export function ensureManagedRuntimeHomeDir(stateDir: string, runtimeId: string): string {
  const homeDir = getManagedRuntimeHomeDir(stateDir, runtimeId);
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  return homeDir;
}

export function attachTaskManagedMcpConnection(
  connection: McpTaskSessionConnection,
  config: RemoteDaemonConfig,
  runtime: RemoteRuntimeRecord,
): McpTaskSessionConnection {
  if (connection.transport === "managed_stdio") {
    return { ...connection, managedStdioLaunch: buildManagedStdioLaunch(connection, config, runtime) };
  }
  return resolveManagedServiceConnection(connection);
}

export function attachManagedMcpConnection(
  connection: ResolvedMcpConnection,
  config: RemoteDaemonConfig,
  runtime: RemoteRuntimeRecord,
): ResolvedMcpConnection {
  if (connection.transport === "managed_stdio") {
    return { ...connection, managedStdioLaunch: buildManagedStdioLaunch(connection, config, runtime) };
  }
  return resolveManagedServiceConnection(connection);
}

export function resolveManagedServiceConnection<T extends McpTaskSessionConnection | ResolvedMcpConnection>(
  connection: T,
  environment: Record<string, string | undefined> = process.env,
): T & { managedServiceEndpoint?: string } {
  if (connection.transport !== "managed_service") return connection;
  if (connection.endpoint !== "managed-service://openmontage") {
    throw new Error("OpenMontage managed service reference is not trusted.");
  }
  const rawEndpoint = environment.OPENMONTAGE_MCP_URL?.trim();
  if (!rawEndpoint) throw new Error("OPENMONTAGE_MCP_URL is required for the OpenMontage managed service.");
  const token = environment.OPENMONTAGE_SERVICE_TOKEN?.trim();
  if (!token) throw new Error("OPENMONTAGE_SERVICE_TOKEN is required for the OpenMontage managed service.");
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new Error("OPENMONTAGE_MCP_URL must be a valid HTTP URL ending in /mcp.");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol)
    || !endpoint.hostname
    || endpoint.pathname !== "/mcp"
    || endpoint.search
    || endpoint.hash
    || endpoint.username
    || endpoint.password
  ) {
    throw new Error("OPENMONTAGE_MCP_URL must be a credential-free HTTP URL ending in /mcp.");
  }
  return {
    ...connection,
    managedServiceEndpoint: endpoint.toString(),
    secrets: { Authorization: `Bearer ${token}` },
  };
}

export function buildManagedStdioLaunch(
  connection: Pick<ResolvedMcpConnection, "endpoint" | "nonSecretParams" | "secrets" | "managedStdioProfile">,
  config: Pick<RemoteDaemonConfig, "stateDir" | "managedNode">,
  runtime: Pick<RemoteRuntimeRecord, "id" | "provider">,
): McpManagedStdioLaunch {
  const entryPoint = parseManagedStdioEndpoint(connection.endpoint);
  const runtimeHomeDir = ensureManagedRuntimeHomeDir(config.stateDir, runtime.id);
  const env = {
    ...resolveManagedStdioEnvironment(connection.nonSecretParams, connection.secrets),
    ...resolveManagedStdioEnvironment(connection.managedStdioProfile?.env ?? {}, {}),
  };
  const profileArgs = connection.managedStdioProfile?.args ?? [];
  if (!config.managedNode) {
    return {
      command: join(runtimeHomeDir, ".local", "bin", entryPoint),
      args: [...profileArgs],
      env: {
        ...env,
        HOME: runtimeHomeDir,
        PATH: `${join(runtimeHomeDir, ".local", "bin")}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
      },
    };
  }
  const containerPath = "/dofe-home/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  return {
    command: "docker",
    args: [
      "run", "--rm", "--interactive", "--init", "--pull", "never", "--read-only", "--network", "none",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec", "--tmpfs", "/dev/shm:rw,nosuid,nodev,noexec,size=256m",
      "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
      "--user", `${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`,
      "--mount", `type=bind,src=${runtimeHomeDir},dst=/dofe-home`,
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--env", "HOME=/dofe-home", "--env", `PATH=${containerPath}`,
      "--entrypoint", `/dofe-home/.local/bin/${entryPoint}`,
      buildManagedRuntimeImage(runtime.provider),
      ...profileArgs,
      ...(connection.managedStdioProfile?.managedArgs ?? []),
    ],
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
  };
}

function parseManagedStdioEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("mcp.managed_stdio_endpoint_invalid");
  }
  const command = url.hostname;
  if (url.protocol !== "stdio:" || url.pathname !== "" || url.search || url.hash || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(command)) {
    throw new Error("mcp.managed_stdio_endpoint_invalid");
  }
  return command;
}

function resolveManagedStdioEnvironment(
  nonSecretParams: Record<string, unknown>,
  secrets: Record<string, string>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, raw] of [...Object.entries(nonSecretParams), ...Object.entries(secrets)]) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(key) || ["HOME", "PATH"].includes(key) || key.startsWith("DOFE_")) {
      throw new Error("mcp.managed_stdio_environment_invalid");
    }
    if (typeof raw !== "string" || raw.length > 8192) throw new Error("mcp.managed_stdio_environment_invalid");
    values[key] = raw;
  }
  return values;
}

const sharedMcpGateways = new McpGatewayPool();

export async function getMcpGatewayForTask(
  client: HttpDaemonClient,
  auditOutbox: McpAuditOutbox,
  managedNode: boolean,
): Promise<McpGateway> {
  const gatewayHost = managedNode
    ? resolveManagedRuntimeDockerGateway(resolveManagedRuntimeDockerNetwork())
    : "127.0.0.1";
  return sharedMcpGateways.getOrCreate(gatewayHost, async () => {
    const gateway = new McpGateway(
      async (audit) => {
        const report = {
          taskId: audit.taskId,
          connectionId: audit.connectionId,
          toolName: audit.toolName,
          outcome: audit.outcome,
          latencyMs: audit.latencyMs,
          safeSummary: audit.safeSummary,
          eventId: audit.eventId,
        };
        auditOutbox.enqueue(report);
        await auditOutbox.flush(client).then((result) => {
          if (result.failed === 0) return;
          console.error(`MCP audit outbox retained ${result.failed} event(s) for retry.`);
        }).catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`MCP audit outbox flush failed for task ${audit.taskId}: ${detail}`);
        });
      },
      undefined,
      async (input) => {
        try {
          const response = await client.validateMcpConnectionForTask(input.taskId, input.connectionId, {
            toolName: input.toolName,
          });
          return response.ok
            ? {
                ok: true,
                approvedTools: response.approvedTools ?? [],
                egressProxyLease: response.egressProxyLease,
                egressProxyPolicySnapshot: response.egressProxyPolicySnapshot,
              }
            : { ok: false };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`MCP connection validation failed for task ${input.taskId}: ${detail}`);
          return { ok: false };
        }
      },
      { listenHost: gatewayHost, advertisedHost: gatewayHost },
      (report) => client.reportOpenMontageJob(report.taskId, {
        connectionId: report.connectionId,
        snapshot: report.snapshot,
      }).then(() => undefined),
    );
    await gateway.start();
    return gateway;
  });
}
