// 3.5-4：自 remote-daemon.ts 拆出——runtime-app/skill 安装/skill 服务操作队列
// 执行器，以及托管 runtime provisioning/清理轮询。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDaemonRuntimeAppDepsRootPath } from "@dofe-agent/db";
import type {
  ClaimedManagedSkillServiceOperation,
  ClaimedRuntimeAppOperation,
  ClaimedSkillInstallationOperation,
  ManagedRuntimeCleanupRequest,
} from "../daemon-api.ts";
import type { HttpDaemonClient } from "../daemon-client.ts";
import { executeSkillInstallationOperation } from "../skill-install/operation-worker.ts";
import { executeSkillServiceOperation } from "../skill-service/service-operation-worker.ts";
import type { RemoteRuntimeRecord } from "../provider-runtime.ts";
import {
  buildManagedRuntimeAppPlan,
  executeRuntimeAppPlan,
  parseRuntimeAppInstallPlan,
  resolveRuntimeAppRegistryEnvironment,
} from "../runtime-apps.ts";
import type { ProviderCredentialProfile } from "../provider-credentials.ts";
import {
  buildManagedRuntimeDockerConnectivityArgs,
  resolveManagedRuntimeInstallDockerNetwork,
  type ManagedCredentialResolver,
} from "../managed-provider-credentials.ts";
import { createManagedProvisioningExecutor } from "../managed-runtime-provisioning.ts";
import type { RemoteDaemonConfig } from "./config.ts";
import { ensureManagedRuntimeHomeDir } from "./mcp.ts";
import type { ManagedRuntimeEntry } from "./heartbeat.ts";
import { readErrorTail } from "./internal.ts";
import { buildManagedRuntimeImage } from "../managed-runtime-image.ts";

export async function executeRemoteRuntimeAppOperation(
  client: HttpDaemonClient,
  config: RemoteDaemonConfig,
  runtime: RemoteRuntimeRecord,
  operation: ClaimedRuntimeAppOperation,
): Promise<void> {
  await client.startRuntimeAppOperation(operation.id);
  const plan = parseRuntimeAppInstallPlan(operation.commandPlan);
  if (!plan) {
    await client.failRuntimeAppOperation(operation.id, {
      errorCode: "runtime_app.invalid_plan",
      errorMessage: "Runtime app operation command plan is invalid.",
    });
    return;
  }
  try {
    // GitHub-skill dependency plans install into relative deps/<manager> dirs;
    // the runtime app deps root is the executor cwd so they stay isolated from
    // Provider HOME/global package paths.
    const depsRoot = getDaemonRuntimeAppDepsRootPath(config.stateDir, {
      workspaceId: operation.workspaceId,
    });
    mkdirSync(depsRoot, { recursive: true });
    const runtimeHomeDir = ensureManagedRuntimeHomeDir(config.stateDir, runtime.id);
    const executionPlan = config.managedNode
      ? buildManagedRuntimeAppPlan(plan, {
          image: buildManagedRuntimeImage(runtime.provider),
          runtimeHomeDir,
          depsRoot,
          dockerNetwork: resolveManagedRuntimeInstallDockerNetwork(),
          dockerConnectivityArgs: buildManagedRuntimeDockerConnectivityArgs(),
          registryEnvironment: resolveRuntimeAppRegistryEnvironment(),
          user: `${process.getuid?.() ?? 10001}:${process.getgid?.() ?? 10001}`,
        })
      : plan;
    const result = await executeRuntimeAppPlan(executionPlan, {
      cwd: depsRoot,
      runtimeHomeDir,
      onStage: (stage) => client.updateRuntimeAppOperationStage(operation.id, { stage }),
    });
    await client.updateRuntimeAppOperationStage(operation.id, { stage: "finalizing" });
    await client.completeRuntimeAppOperation(operation.id, {
      safeStdoutTail: result.safeStdoutTail,
      safeStderrTail: result.safeStderrTail,
      installedApp: {
        displayName: plan.app.name,
        version: plan.app.version,
        entryPoint: plan.app.entryPoint,
        installStrategy: plan.strategy,
          metadataJson: JSON.stringify({
            verifiedAt: new Date().toISOString(),
            strategy: plan.strategy,
            installScope: "runtime_private",
            hostInstallRoot: join(runtimeHomeDir, ".local"),
            runtimeInstallRoot: config.managedNode ? "/dofe-home/.local" : join(runtimeHomeDir, ".local"),
          // Reproducibility record (P1-4): the registry integrity lock and the
          // sha256 of the installed deps dir — both are audit-only, never secrets.
          ...(plan.integrityLock ? { integrityLock: plan.integrityLock } : {}),
          ...(result.downloadedDigest ? { downloadedDigest: result.downloadedDigest } : {}),
        }),
      },
    });
  } catch (error) {
    await client.failRuntimeAppOperation(operation.id, {
      safeStdoutTail: readErrorTail(error, "stdout"),
      safeStderrTail: readErrorTail(error, "stderr"),
      errorCode: error instanceof Error && error.message.startsWith("runtime_app.")
        ? error.message
        : "runtime_app.command_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function executeRemoteSkillInstallationOperation(
  client: HttpDaemonClient,
  config: RemoteDaemonConfig,
  operation: ClaimedSkillInstallationOperation,
): Promise<void> {
  await executeSkillInstallationOperation(client, config, operation);
}

export async function executeRemoteSkillServiceOperation(
  client: HttpDaemonClient,
  config: RemoteDaemonConfig,
  operation: ClaimedManagedSkillServiceOperation,
): Promise<void> {
  await executeSkillServiceOperation(client, config, operation);
}

export async function resolveManagedCredentialProfile(
  runtime: RemoteRuntimeRecord,
  credentialResolver?: ManagedCredentialResolver,
): Promise<ProviderCredentialProfile | null> {
  if (!runtime.metadata.managedCredentialId || !credentialResolver) {
    return null;
  }
  return credentialResolver.resolve(runtime.id, runtime.metadata.managedCredentialId);
}

export async function pollManagedProvisioningTasks(
  client: HttpDaemonClient,
  executor: ReturnType<typeof createManagedProvisioningExecutor>,
  managedRuntimes: Map<string, ManagedRuntimeEntry>,
): Promise<void> {
  const claimed = await client.claimManagedProvisioningTask();
  if (!claimed.task) {
    return;
  }
  const task = claimed.task;
  console.log(`Managed provisioning: ${task.stage} for ${task.runtimeId}`);
  try {
    const result = await executor.execute(task);
    if (!result.success) {
      await client.failManagedProvisioningStage(task.taskId, task.stage, {
        runtimeId: task.runtimeId,
        errorCode: result.errorCode ?? "managed_runtime.stage_failed",
        errorMessage: result.errorMessage ?? "Unknown stage failure",
      });
      return;
    }
    await client.completeManagedProvisioningStage(task.taskId, task.stage, { runtimeId: task.runtimeId });
    if (task.stage === "health_check") {
      managedRuntimes.set(task.runtimeId, {
        id: task.runtimeId,
        provider: task.runtimeType,
        runtimeCredentialId: task.runtimeCredentialId,
        executablePath: executor.credentialResolver.getExecutablePath(task.runtimeId, task.runtimeType),
        status: "online",
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client.failManagedProvisioningStage(task.taskId, task.stage, {
      runtimeId: task.runtimeId,
      errorCode: "managed_runtime.unhandled_error",
      errorMessage: message,
    });
  }
}

export async function executeManagedCleanupRequests(
  client: HttpDaemonClient,
  executor: ReturnType<typeof createManagedProvisioningExecutor>,
  managedRuntimes: Map<string, ManagedRuntimeEntry>,
  requests: ManagedRuntimeCleanupRequest[],
): Promise<void> {
  for (const request of requests) {
    console.log(`Managed cleanup: ${request.runtimeId}`);
    try {
      const result = await executor.executeCleanup(request.runtimeId, request.commands);
      if (result.success) {
        await client.completeManagedRuntimeCleanupRequest(request.requestId, {
          result: { success: true, safeStdoutTail: result.safeStdoutTail, safeStderrTail: result.safeStderrTail },
        });
      } else {
        await client.failManagedRuntimeCleanupRequest(request.requestId, {
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        });
      }
      if (result.success) {
        managedRuntimes.delete(request.runtimeId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await client.failManagedRuntimeCleanupRequest(request.requestId, { errorMessage: message });
    }
  }
}
