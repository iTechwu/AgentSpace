import { mkdirSync, rmSync } from "node:fs";
import { getDaemonRuntimeWorkspaceDirPath } from "@dofe-agent/db";
import type { ClaimedWorkspaceMountOperation } from "@dofe-agent/domain";
import type { HttpDaemonClient } from "./daemon-client.ts";
import type { RemoteDaemonConfig } from "./remote-daemon.ts";
import { materializeHeadRevisionToWorkDirStrict } from "./workdir-capture.ts";

/**
 * Executes a claimed workspace-mount operation: FAIL-CLOSED materialization of
 * the employee's durable head revision into the runtime's PERSISTENT workspace
 * dir (D-07/D-08). Any divergence (missing head, head-revision-id mismatch,
 * unreadable blob, digest mismatch, materialized-count mismatch) fails the
 * operation, so recovery never proceeds on a partial or tampered workspace.
 * Unlike a transient verify dir, the materialized tree is KEPT — it becomes the
 * runtime's durable workspace that future tasks build on.
 */
export async function executeWorkspaceMountOperation(
  client: HttpDaemonClient,
  config: RemoteDaemonConfig,
  operation: ClaimedWorkspaceMountOperation,
): Promise<void> {
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void client.renewWorkspaceMountOperationLease(operation.operationId, operation.claimGeneration)
      .then((renewed) => {
        if (!renewed) leaseLost = true;
      })
      .catch(() => {
        // A transient failure is retried by the next heartbeat. Completion is
        // independently fenced by claimGeneration and lease expiry.
      });
  }, 30_000);
  heartbeat.unref();
  try {
    await client.startWorkspaceMountOperation(operation.operationId, operation.claimGeneration);
    const workspaceDir = getDaemonRuntimeWorkspaceDirPath(config.stateDir, {
      workspaceId: operation.workspaceId,
      runtimeId: operation.runtimeId,
      employeeName: operation.employeeName,
    });
    mkdirSync(workspaceDir, { recursive: true });
    const result = materializeHeadRevisionToWorkDirStrict(workspaceDir, {
      workspaceId: operation.workspaceId,
      employeeName: operation.employeeName,
      expectedHeadRevisionId: operation.headRevisionId,
    });
    if (leaseLost) {
      throw new Error("Workspace mount lease was lost while materializing.");
    }
    await client.completeWorkspaceMountOperation(operation.operationId, {
      materializedFiles: result.materializedFiles,
      mountedPath: workspaceDir,
      runtimeId: operation.runtimeId,
      claimGeneration: operation.claimGeneration,
    });
  } catch (error) {
    await client.failWorkspaceMountOperation(operation.operationId, {
      errorCode: "workspace_mount.materialization_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      runtimeId: operation.runtimeId,
      claimGeneration: operation.claimGeneration,
    });
  } finally {
    clearInterval(heartbeat);
    // The persistent runtime workspace is deliberately kept. A retry reuses
    // only regular files whose digest matches the pinned durable revision;
    // divergent or symlinked targets remain a fail-closed mount error.
  }
}
