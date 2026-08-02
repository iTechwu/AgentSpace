import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { getDaemonSkillInstallCachePath, getDaemonSkillInstallWorkDirPath } from "@dofe-agent/db";
import type { ClaimedSkillInstallationOperation } from "@dofe-agent/domain";
import type { HttpDaemonClient } from "../daemon-client.ts";
import type { RemoteDaemonConfig } from "../remote-daemon.ts";
import {
  materializeSkillInstallationArtifact,
  SkillMaterializationError,
  type MaterializedSkillFile,
  type MaterializeResult,
} from "./artifact-materializer.ts";
import { verifySkillInstallationComponents } from "./component-verifier.ts";

const KEEP_WORK_DIR_ENV = "DOFE_AGENT_KEEP_SKILL_INSTALL_WORK_DIR";
const DISABLE_CACHE_ENV = "DOFE_AGENT_DISABLE_SKILL_INSTALL_CACHE";
const CACHE_COMPLETE_SENTINEL = ".cache-complete";
const CACHE_META_FILE = ".cache-result.json";

interface CachedMaterializeResult {
  files: MaterializedSkillFile[];
  computedDigest: string;
  expectedDigest: string;
}

/**
 * Executes a claimed skill installation operation end-to-end on the Remote
 * Runtime: materialize the artifact (or reuse the digest-keyed Runtime cache),
 * verify its integrity, run component checks, and report evidence back to the
 * control plane. The per-operation workDir is transient and always cleaned up;
 * the cache root survives across operations so a re-install of the same
 * artifact digest reuses materialized files instead of re-downloading them.
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

  const cacheEnabled = !process.env[DISABLE_CACHE_ENV];
  const cachePath = getDaemonSkillInstallCachePath(config.stateDir, {
    workspaceId: operation.workspaceId,
    artifactDigest: operation.artifactDigest,
  });
  let cacheHit = false;

  try {
    let materializeResult: MaterializeResult;
    if (cacheEnabled && existsSync(join(cachePath, CACHE_COMPLETE_SENTINEL))) {
      copyTree(cachePath, workDir);
      materializeResult = readCachedMaterializeResult(cachePath);
      cacheHit = true;
    } else {
      materializeResult = await materializeSkillInstallationArtifact(operation, workDir);
      if (cacheEnabled && materializeResult.rootDigestMatches) {
        publishToCache(workDir, cachePath, materializeResult);
      }
    }

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
        cacheHit,
        preparedPath: cacheEnabled && cacheHit ? cachePath : undefined,
      }),
      componentStatuses,
    });
  } catch (error) {
    // On failure, report the computed partial component statuses THROUGH the fail
    // payload (the control plane persists them, then blocks the rest). The old
    // complete-after-fail flow is gone: complete now requires the EXACT expected
    // set, so a partial complete would be rejected as a set mismatch.
    const componentStatuses = error instanceof SkillVerificationError
      ? error.componentStatuses
      : [];

    await client.failSkillInstallationOperation(operation.operationId, {
      errorCode: error instanceof SkillMaterializationError || error instanceof SkillVerificationError
        ? error.code
        : "skill_installation.runtime_error",
      errorMessage: error instanceof Error ? error.message : String(error),
      ...(componentStatuses.length > 0 ? { componentStatuses } : {}),
    });
  } finally {
    if (!process.env[KEEP_WORK_DIR_ENV]) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

function readCachedMaterializeResult(cachePath: string): MaterializeResult {
  const raw = readFileSync(join(cachePath, CACHE_META_FILE), "utf8");
  const meta = JSON.parse(raw) as CachedMaterializeResult;
  return {
    files: meta.files,
    rootDigestMatches: meta.computedDigest === meta.expectedDigest,
    computedDigest: meta.computedDigest,
    expectedDigest: meta.expectedDigest,
  };
}

/**
 * Atomically publishes a verified materialization into the digest-keyed cache:
 * copy to a per-op staging dir, write the completion sentinel, then rename into
 * place. If another operation for the same digest won the race, the rename fails
 * and we discard our staging copy — the winner's entry is identical (content
 * addressed by digest).
 */
function publishToCache(workDir: string, cachePath: string, result: MaterializeResult): void {
  if (existsSync(cachePath)) {
    return;
  }
  const stagingPath = `${cachePath}.staging`;
  rmSync(stagingPath, { recursive: true, force: true });
  mkdirSync(dirname(stagingPath), { recursive: true });
  copyTree(workDir, stagingPath);

  const meta: CachedMaterializeResult = {
    files: result.files,
    computedDigest: result.computedDigest,
    expectedDigest: result.expectedDigest,
  };
  writeFileSync(join(stagingPath, CACHE_META_FILE), JSON.stringify(meta));
  writeFileSync(join(stagingPath, CACHE_COMPLETE_SENTINEL), new Date().toISOString());

  try {
    renameSync(stagingPath, cachePath);
  } catch {
    rmSync(stagingPath, { recursive: true, force: true });
  }
}

/** Recursively copies a directory tree, preserving the executable bit. */
function copyTree(sourceDir: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(sourcePath, targetPath);
    } else if (entry.isFile()) {
      copyFileSync(sourcePath, targetPath);
      const mode = statSync(sourcePath).mode & 0o111;
      if (mode > 0) {
        chmodSync(targetPath, statSync(sourcePath).mode & 0o777);
      }
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
