import { mkdirSync, rmSync } from "node:fs";
import { getDaemonSkillInstallWorkDirPath } from "@dofe-agent/db";
import type { ClaimedSkillInstallationOperation } from "@dofe-agent/domain";
import type { HttpDaemonClient } from "../daemon-client.ts";
import type { RemoteDaemonConfig } from "../remote-daemon.ts";
import {
  materializeSkillInstallationArtifact,
  SkillMaterializationError,
} from "./artifact-materializer.ts";
import { verifySkillInstallationComponents } from "./component-verifier.ts";

const KEEP_WORK_DIR_ENV = "DOFE_AGENT_KEEP_SKILL_INSTALL_WORK_DIR";

/**
 * Executes a claimed skill installation operation end-to-end on the Remote
 * Runtime: materialize the artifact, verify its integrity, run component
 * checks, and report evidence back to the control plane.
 */
export async function executeSkillInstallationOperation(
  client: HttpDaemonClient,
  config: RemoteDaemonConfig,
  operation: ClaimedSkillInstallationOperation,
): Promise<void> {
  await client.startSkillInstallationOperation(operation.operationId);

  const workDir = getDaemonSkillInstallWorkDirPath(config.stateDir, {
    workspaceId: operation.workspaceId,
    installationId: operation.installationId,
    operationId: operation.operationId,
  });
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  try {
    const materializeResult = await materializeSkillInstallationArtifact(operation, workDir);
    if (!materializeResult.rootDigestMatches) {
      throw new SkillMaterializationError(
        `Artifact digest mismatch: expected ${materializeResult.expectedDigest}, computed ${materializeResult.computedDigest}`,
        "skill_installation.root_digest_mismatch",
      );
    }

    const componentStatuses = verifySkillInstallationComponents(
      operation,
      workDir,
      materializeResult.rootDigestMatches,
    );

    const allReady = componentStatuses.every((component) => component.status === "ready");
    if (!allReady) {
      const blocked = componentStatuses.find((component) =>
        component.status !== "ready");
      throw new SkillVerificationError(
        blocked?.errorMessage ?? "One or more components failed verification",
        blocked?.errorCode ?? "skill_installation.component_verification_failed",
        componentStatuses,
      );
    }

    await client.completeSkillInstallationOperation(operation.operationId, {
      safeResultJson: JSON.stringify({
        materializedFiles: materializeResult.files.length,
        computedDigest: materializeResult.computedDigest,
      }),
      componentStatuses,
    });
  } catch (error) {
    const componentStatuses = error instanceof SkillVerificationError
      ? error.componentStatuses
      : [];

    await client.failSkillInstallationOperation(operation.operationId, {
      errorCode: error instanceof SkillMaterializationError || error instanceof SkillVerificationError
        ? error.code
        : "skill_installation.runtime_error",
      errorMessage: error instanceof Error ? error.message : String(error),
    });

    // If we already computed component statuses before failure, best-effort
    // complete them so the control plane can see partial evidence.
    if (componentStatuses.length > 0) {
      await client.completeSkillInstallationOperation(operation.operationId, {
        componentStatuses,
      }).catch((completeError) => {
        const detail = completeError instanceof Error ? completeError.message : String(completeError);
        console.error(`Failed to report partial component statuses for ${operation.operationId}: ${detail}`);
      });
    }
  } finally {
    if (!process.env[KEEP_WORK_DIR_ENV]) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

class SkillVerificationError extends Error {
  readonly code: string;
  readonly componentStatuses: ReturnType<typeof verifySkillInstallationComponents>;

  constructor(
    message: string,
    code: string,
    componentStatuses: ReturnType<typeof verifySkillInstallationComponents>,
  ) {
    super(message);
    this.name = "SkillVerificationError";
    this.code = code;
    this.componentStatuses = componentStatuses;
  }
}
