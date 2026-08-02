import { mkdirSync, rmSync } from "node:fs";
import { getDaemonWorkspaceMountWorkDirPath } from "@dofe-agent/db";
import type { ClaimedWorkspaceMountOperation } from "@dofe-agent/domain";
import type { HttpDaemonClient } from "./daemon-client.ts";
import type { RemoteDaemonConfig } from "./remote-daemon.ts";
import { materializeHeadRevisionToWorkDirStrict } from "./workdir-capture.ts";

const KEEP_WORK_DIR_ENV = "DOFE_AGENT_KEEP_SKILL_INSTALL_WORK_DIR";

/**
 * Executes a claimed workspace-mount operation: FAIL-CLOSED materialization of
 * the employee's durable head revision onto a transient verification dir on the
 * runtime. Any divergence (missing head, head-revision-id mismatch, unreadable
 * blob, digest mismatch, materialized-count mismatch) fails the operation, so
 * the recovery orchestrator never proceeds on a partial or tampered workspace.
 */
export async function executeWorkspaceMountOperation(
  client: HttpDaemonClient,
  config: RemoteDaemonConfig,
  operation: ClaimedWorkspaceMountOperation,
): Promise<void> {
  const workDir = getDaemonWorkspaceMountWorkDirPath(config.stateDir, {
    workspaceId: operation.workspaceId,
    operationId: operation.operationId,
  });
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  try {
    const result = materializeHeadRevisionToWorkDirStrict(workDir, {
      workspaceId: operation.workspaceId,
      employeeName: operation.employeeName,
      expectedHeadRevisionId: operation.headRevisionId,
    });
    await client.completeWorkspaceMountOperation(operation.operationId, {
      materializedFiles: result.materializedFiles,
      runtimeId: operation.runtimeId,
    });
  } catch (error) {
    await client.failWorkspaceMountOperation(operation.operationId, {
      errorCode: "workspace_mount.materialization_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      runtimeId: operation.runtimeId,
    });
  } finally {
    if (!process.env[KEEP_WORK_DIR_ENV]) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}
