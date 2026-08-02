import { mkdirSync, rmSync } from "node:fs";
import { getDaemonWorkspaceMountWorkDirPath } from "@dofe-agent/db";
import type { ClaimedWorkspaceMountOperation } from "@dofe-agent/domain";
import type { HttpDaemonClient } from "./daemon-client.ts";
import type { RemoteDaemonConfig } from "./remote-daemon.ts";
import { materializeHeadRevisionToWorkDir } from "./workdir-capture.ts";

const KEEP_WORK_DIR_ENV = "DOFE_AGENT_KEEP_SKILL_INSTALL_WORK_DIR";

/**
 * Executes a claimed workspace-mount operation: materializes the employee's
 * durable head revision onto a transient verification dir on the runtime, then
 * reports the materialized file count. A completed mount is the evidence that
 * the target runtime can read the workspace's content-addressed blobs, which
 * the recovery orchestrator waits on before proceeding to skill install and
 * activation.
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
    const result = materializeHeadRevisionToWorkDir(workDir, {
      workspaceId: operation.workspaceId,
      employeeName: operation.employeeName,
    });
    await client.completeWorkspaceMountOperation(operation.operationId, {
      materializedFiles: result.materializedFiles,
    });
  } catch (error) {
    await client.failWorkspaceMountOperation(operation.operationId, {
      errorCode: "workspace_mount.materialization_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (!process.env[KEEP_WORK_DIR_ENV]) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}
