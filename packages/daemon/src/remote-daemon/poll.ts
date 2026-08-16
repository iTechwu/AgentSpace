// 3.5-4：自 remote-daemon.ts 拆出——每个 tick 的任务与操作队列认领循环。
import type { HttpDaemonClient } from "../daemon-client.ts";
import { DaemonResourceGoneError } from "../daemon-client.ts";
import { executeMcpConnectionOperation } from "../mcp/verify-executor.ts";
import type { McpAuditOutbox } from "../mcp/audit-outbox.ts";
import type { RemoteRuntimeRecord } from "../provider-runtime.ts";
import type { ManagedCredentialResolver } from "../managed-provider-credentials.ts";
import type { RemoteDaemonConfig } from "./config.ts";
import {
  beginRemoteRuntimeTask,
  endRemoteRuntimeTask,
  releaseRemoteRuntimeExclusiveSlot,
  reserveRemoteRuntimeExclusiveSlot,
  type RemoteRuntimeActivity,
} from "./activity.ts";
import { classifyRemoteLoopError } from "./errors.ts";
import { claimRemoteQueue } from "./queue.ts";
import { attachManagedMcpConnection } from "./mcp.ts";
import {
  executeRemoteRuntimeAppOperation,
  executeRemoteSkillInstallationOperation,
  executeRemoteSkillServiceOperation,
} from "./operations.ts";
import { executeRemoteTask } from "./task-execution.ts";
import { executeWorkspaceMountOperation } from "../workspace-mount-operation-worker.ts";

export async function pollRemoteTasks(
  client: HttpDaemonClient,
  config: RemoteDaemonConfig,
  runtimes: RemoteRuntimeRecord[],
  activity: RemoteRuntimeActivity,
  credentialResolver: ManagedCredentialResolver,
  mcpAuditOutbox: McpAuditOutbox,
): Promise<void> {
  const now = Date.now();
  for (const runtime of runtimes) {
    if (activity.exclusiveRuntimes.has(runtime.id)) {
      continue;
    }
    try {
      const hasActiveTasks = (activity.taskCounts.get(runtime.id) ?? 0) > 0;
      // 3.5-8：操作队列（app/MCP/skill/service/mount）是低频运维信号，
      // 空闲轮询全部扑空后按 operationClaimIntervalMs 背压；任务 claim
      // 保持每 tick 一次不变（用户可感知延迟）。任一操作被认领即清零背压，
      // 让批量操作（如连续 skill 安装）不被节流。
      const operationClaimEligible = !hasActiveTasks
        && (activity.nextOperationClaimAt.get(runtime.id) ?? 0) <= now;
      if (operationClaimEligible) {
        let claimedOperation = false;
        const appOperation = await claimRemoteQueue({
          runtimeId: runtime.id,
          queue: "runtime app operation",
          claim: () => client.claimRuntimeAppOperation(runtime.id),
        });
        if (appOperation?.operation) {
          claimedOperation = true;
          reserveRemoteRuntimeExclusiveSlot(activity, runtime.id);
          void executeRemoteRuntimeAppOperation(client, config, runtime, appOperation.operation)
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`Runtime app operation ${appOperation.operation?.id ?? "unknown"} crashed: ${message}`);
            })
            .finally(() => {
              releaseRemoteRuntimeExclusiveSlot(activity, runtime.id);
            });
          continue;
        }

        const mcpOperation = await claimRemoteQueue({
          runtimeId: runtime.id,
          queue: "MCP operation",
          claim: () => client.claimMcpConnectionOperation(runtime.id),
        });
        if (mcpOperation?.operation) {
          claimedOperation = true;
          reserveRemoteRuntimeExclusiveSlot(activity, runtime.id);
          void executeMcpConnectionOperation(client, mcpOperation.operation, {
            resolveConnection: (connection) => attachManagedMcpConnection(connection, config, runtime),
          })
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`MCP operation ${mcpOperation.operation?.id ?? "unknown"} crashed: ${message}`);
            })
            .finally(() => {
              releaseRemoteRuntimeExclusiveSlot(activity, runtime.id);
            });
          continue;
        }

        const skillOperation = await claimRemoteQueue({
          runtimeId: runtime.id,
          queue: "skill installation operation",
          claim: () => client.claimSkillInstallationOperation(runtime.id),
        });
        if (skillOperation?.operation) {
          claimedOperation = true;
          reserveRemoteRuntimeExclusiveSlot(activity, runtime.id);
          void executeRemoteSkillInstallationOperation(client, config, skillOperation.operation)
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`Skill installation operation ${skillOperation.operation?.operationId ?? "unknown"} crashed: ${message}`);
            })
            .finally(() => {
              releaseRemoteRuntimeExclusiveSlot(activity, runtime.id);
            });
          continue;
        }

        const serviceOperation = await claimRemoteQueue({
          runtimeId: runtime.id,
          queue: "skill service operation",
          claim: () => client.claimSkillServiceOperation(runtime.id),
        });
        if (serviceOperation?.operation) {
          claimedOperation = true;
          reserveRemoteRuntimeExclusiveSlot(activity, runtime.id);
          void executeRemoteSkillServiceOperation(client, config, serviceOperation.operation)
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`Skill service operation ${serviceOperation.operation?.operationId ?? "unknown"} crashed: ${message}`);
            })
            .finally(() => {
              releaseRemoteRuntimeExclusiveSlot(activity, runtime.id);
            });
          continue;
        }

        const mountOperation = await claimRemoteQueue({
          runtimeId: runtime.id,
          queue: "workspace mount operation",
          claim: () => client.claimWorkspaceMountOperation(runtime.id),
        });
        if (mountOperation?.operation) {
          claimedOperation = true;
          reserveRemoteRuntimeExclusiveSlot(activity, runtime.id);
          void executeWorkspaceMountOperation(client, config, mountOperation.operation)
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              console.error(`Workspace mount operation ${mountOperation.operation?.operationId ?? "unknown"} crashed: ${message}`);
            })
            .finally(() => {
              releaseRemoteRuntimeExclusiveSlot(activity, runtime.id);
            });
          continue;
        }

        if (!claimedOperation) {
          // 级联全空：背压下一次操作 claim；±20% 抖动去同步多 runtime 波峰。
          // 认领成功的分支已 continue，天然重置为立即再查。
          const jitter = 0.8 + Math.random() * 0.4;
          activity.nextOperationClaimAt.set(
            runtime.id,
            now + config.operationClaimIntervalMs * jitter,
          );
        }
      }

      const claimed = await claimRemoteQueue({
        runtimeId: runtime.id,
        queue: "task",
        claim: () => client.claimTask(runtime.id),
      });
      if (!claimed?.task) {
        continue;
      }

      if (!beginRemoteRuntimeTask(activity, runtime.id)) {
        throw new Error(`Runtime ${runtime.id} entered maintenance after claiming task ${claimed.task.id}.`);
      }
      void executeRemoteTask(client, config, runtime, claimed.task, credentialResolver, mcpAuditOutbox)
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Remote task ${claimed.task?.id ?? "unknown"} crashed: ${message}`);
        })
        .finally(() => {
          endRemoteRuntimeTask(activity, runtime.id);
        });
    } catch (error) {
      if (classifyRemoteLoopError(error) === "skip-runtime") {
        if (error instanceof DaemonResourceGoneError) {
          // The next successful heartbeat prunes a server-deleted runtime.
          console.warn(
            `Runtime ${runtime.id} no longer exists on the server; skipping until heartbeat reconciles.`,
          );
        } else {
          // A newly provisioned managed runtime can briefly be ineligible to
          // claim work before the next heartbeat reports it online.
          console.debug(
            `Runtime ${runtime.id} is temporarily unavailable; waiting for heartbeat reconciliation.`,
          );
        }
        continue;
      }
      throw error;
    }
  }
}
