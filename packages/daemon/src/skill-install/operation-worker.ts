import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { getDaemonSkillInstallCachePath, getDaemonSkillInstallEnvsDirPath, getDaemonSkillInstallWorkDirPath } from "@dofe-agent/db";
import { connectSandbox } from "@dofe-agent/sandbox";
import { computeArtifactDigest, type SkillArtifactManifest } from "@dofe-agent/services";
import type { ClaimedSkillInstallationOperation } from "@dofe-agent/domain";
import type { HttpDaemonClient } from "../daemon-client.ts";
import type { RemoteDaemonConfig } from "../remote-daemon.ts";
import {
  materializeSkillInstallationArtifact,
  SkillMaterializationError,
  type MaterializedSkillFile,
  type MaterializeResult,
} from "./artifact-materializer.ts";
import { verifySkillInstallationComponents, type DependencyInstallOutcome } from "./component-verifier.ts";
import { installSkillDependenciesSync } from "./dependency-installer.ts";
import { publishSkillDependencyEnvironment } from "./task-environment.ts";

const KEEP_WORK_DIR_ENV = "DOFE_AGENT_KEEP_SKILL_INSTALL_WORK_DIR";
const DISABLE_CACHE_ENV = "DOFE_AGENT_DISABLE_SKILL_INSTALL_CACHE";
const CACHE_COMPLETE_SENTINEL = ".cache-complete";
const CACHE_META_FILE = ".cache-result.json";
/** Lease heartbeat cadence; must be well under the control-plane lease duration (120s). */
const HEARTBEAT_INTERVAL_MS = 30_000;

interface CachedMaterializeResult {
  files: Array<MaterializedSkillFile & { mode: string }>;
  computedDigest: string;
  expectedDigest: string;
  /** Manifest used to compute the digest — required to re-verify the root digest. */
  manifestJson: string;
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
  await client.startSkillInstallationOperation(operation.operationId, {
    claimGeneration: operation.claimGeneration,
  });

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

  // Lease heartbeat: renew while executing; if the lease is lost (crash recovery
  // re-queued the op) abort — the completion would be fenced by the control plane
  // anyway, so stopping early avoids wasted work on a superseded operation.
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void client.renewSkillInstallationOperationLease(operation.operationId, operation.claimGeneration)
      .then((renewed) => {
        if (!renewed) {
          leaseLost = true;
        }
      })
      .catch(() => {
        // A transient renew failure is not fatal; the next beat retries.
      });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  try {
    let materializeResult: MaterializeResult;
    if (
      cacheEnabled
      && existsSync(join(cachePath, CACHE_COMPLETE_SENTINEL))
      && verifyCachedFiles(cachePath, operation)
    ) {
      copyCachedFiles(cachePath, workDir, operation.files);
      materializeResult = readCachedMaterializeResult(cachePath, operation);
      cacheHit = true;
    } else {
      if (cacheEnabled && existsSync(cachePath)) {
        discardCacheEntry(cachePath);
      }
      materializeResult = await materializeSkillInstallationArtifact(operation, workDir);
      if (cacheEnabled && materializeResult.rootDigestMatches) {
        publishToCache(workDir, cachePath, materializeResult, operation);
      }
    }

    if (!materializeResult.rootDigestMatches) {
      throw new SkillMaterializationError(
        `Artifact digest mismatch: expected ${materializeResult.expectedDigest}, computed ${materializeResult.computedDigest}`,
        "skill_installation.root_digest_mismatch",
      );
    }

    // Real dependency install + verify (02-架构设计.md §4.1): npm/pip/uv go into
    // an isolated per-installation envs dir with an allow-listed registry; the
    // verify step independently checks the installed artifact. Only an artifact
    // with zero dependencies skips this (its dependency components stay manifest-
    // based, including the package:integrity component).
    const dependencies = readManifestDependencies(operation.manifestJson);
    const installedDependencies: string[] = [];
    let dependencyInstallResults: Map<string, DependencyInstallOutcome> | undefined;
    if (dependencies.length > 0) {
      const envsDir = getDaemonSkillInstallEnvsDirPath(config.stateDir, {
        workspaceId: operation.workspaceId,
        installationId: operation.installationId,
      });
      const sandbox = await connectSandbox({ runtimeId: operation.runtimeId, workDir: config.stateDir });
      try {
        dependencyInstallResults = await installSkillDependenciesSync({
          dependencies,
          envsDir,
          sandbox,
        });
        for (const [key, result] of dependencyInstallResults) {
          if (result.ok) {
            installedDependencies.push(key);
          }
        }
      } finally {
        await sandbox.stop();
      }
    }

    const componentStatuses = verifySkillInstallationComponents(
      operation,
      workDir,
      materializeResult.rootDigestMatches,
      dependencyInstallResults,
    );

    // Services are control-plane-decided (the daemon reports `pending`), so they
    // are excluded from the daemon-side allReady gate; the control plane overrides
    // them from the service binding state during completion.
    const allReady = componentStatuses.every((component) =>
      component.kind === "service" || component.status === "ready");
    if (!allReady) {
      const blocked = componentStatuses.find((component) =>
        component.kind !== "service" && component.status !== "ready");
      throw new SkillVerificationError(
        blocked?.errorMessage ?? "One or more components failed verification",
        blocked?.errorCode ?? "skill_installation.component_verification_failed",
        componentStatuses,
      );
    }

    if (dependencies.length > 0) {
      if (!operation.releaseLockDigest) {
        throw new Error("skill_dependency_environment_snapshot_invalid: dependency installation has no release lock digest.");
      }
      publishSkillDependencyEnvironment({
        envsDir: getDaemonSkillInstallEnvsDirPath(config.stateDir, {
          workspaceId: operation.workspaceId,
          installationId: operation.installationId,
        }),
        installationId: operation.installationId,
        artifactDigest: operation.artifactDigest,
        releaseLockDigest: operation.releaseLockDigest,
      });
    }

    if (leaseLost) {
      throw new Error("skill_installation.lease_lost: operation lease expired while executing; aborting.");
    }

    await client.completeSkillInstallationOperation(operation.operationId, {
      claimGeneration: operation.claimGeneration,
      safeResultJson: JSON.stringify({
        materializedFiles: materializeResult.files.length,
        computedDigest: materializeResult.computedDigest,
        cacheHit,
        // Report the digest-keyed cache path on both hit and miss (a miss that
        // passed verification just published the cache).
        preparedPath: cacheEnabled ? cachePath : undefined,
        ...(installedDependencies.length > 0 ? { installedDependencies } : {}),
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
      claimGeneration: operation.claimGeneration,
      errorCode: error instanceof SkillMaterializationError || error instanceof SkillVerificationError
        ? error.code
        : "skill_installation.runtime_error",
      errorMessage: error instanceof Error ? error.message : String(error),
      ...(componentStatuses.length > 0 ? { componentStatuses } : {}),
    });
  } finally {
    clearInterval(heartbeat);
    if (!process.env[KEEP_WORK_DIR_ENV]) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

/** Parses the manifest's npm/pip/uv dependency declarations (manager or kind). */
function readManifestDependencies(manifestJson: string): Array<{ manager: "npm" | "pip" | "uv"; name: string; version: string }> {
  try {
    const manifest = JSON.parse(manifestJson) as {
      dependencies?: Array<{ manager?: string; kind?: string; name?: string; version?: string }>;
    };
    const dependencies: Array<{ manager: "npm" | "pip" | "uv"; name: string; version: string }> = [];
    for (const dep of manifest.dependencies ?? []) {
      const manager = dep.manager ?? dep.kind;
      if ((manager === "npm" || manager === "pip" || manager === "uv") && dep.name && dep.version) {
        dependencies.push({ manager, name: dep.name, version: dep.version });
      }
    }
    return dependencies;
  } catch {
    return [];
  }
}

function readCachedMaterializeResult(
  cachePath: string,
  operation: ClaimedSkillInstallationOperation,
): MaterializeResult {
  const raw = readFileSync(join(cachePath, CACHE_META_FILE), "utf8");
  const meta = JSON.parse(raw) as CachedMaterializeResult;
  return {
    files: meta.files,
    rootDigestMatches: true,
    computedDigest: operation.artifactDigest,
    expectedDigest: operation.artifactDigest,
  };
}

/**
 * Atomically publishes a verified materialization into the digest-keyed cache:
 * copy to a UNIQUE per-operation staging dir, write the completion sentinel,
 * then rename into place. Concurrent operations never share a staging path, and
 * if another operation for the same digest won the race the rename fails and we
 * discard our staging copy — the winner's entry is identical (content addressed
 * by digest), i.e. atomic first-write-wins.
 */
function publishToCache(
  workDir: string,
  cachePath: string,
  result: MaterializeResult,
  operation: ClaimedSkillInstallationOperation,
): void {
  if (existsSync(cachePath)) {
    if (verifyCachedFiles(cachePath, operation)) {
      return;
    }
    discardCacheEntry(cachePath);
  }
  const stagingPath = `${cachePath}.staging-${randomUUID()}`;
  mkdirSync(dirname(stagingPath), { recursive: true });
  copyTree(workDir, stagingPath);

  const meta: CachedMaterializeResult = {
    files: operation.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      mediaType: file.mediaType,
      mode: file.mode,
    })),
    computedDigest: result.computedDigest,
    expectedDigest: result.expectedDigest,
    manifestJson: operation.manifestJson,
  };
  writeFileSync(join(stagingPath, CACHE_META_FILE), JSON.stringify(meta));
  writeFileSync(join(stagingPath, CACHE_COMPLETE_SENTINEL), new Date().toISOString());
  sealReadOnlyTree(stagingPath);

  try {
    renameSync(stagingPath, cachePath);
  } catch {
    resetReadOnlyTree(stagingPath);
    rmSync(stagingPath, { recursive: true, force: true });
  }
  if (!verifyCachedFiles(cachePath, operation)) {
    discardCacheEntry(cachePath);
    throw new SkillMaterializationError(
      "Published cache does not match the current installation operation.",
      "skill_installation.cache_publish_failed",
    );
  }
}

/**
 * Content-integrity check before trusting a cached materialization:
 *  1. exact path set — every on-disk file (excluding our metadata) is a declared
 *     manifest file, so extra/surprising files invalidate the cache;
 *  2. per-file SHA-256 must match the manifest (a same-size tamper no longer
 *     passes);
 *  3. the root digest is recomputed from the manifest + sorted file digests and
 *     must equal the recorded digest.
 * A lstat/symlink or any mismatch treats the cache as a miss (re-materialize).
 */
function verifyCachedFiles(
  cachePath: string,
  operation: ClaimedSkillInstallationOperation,
): boolean {
  try {
    const cacheStat = lstatSync(cachePath);
    if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink() || (cacheStat.mode & 0o222) !== 0) {
      return false;
    }
    const raw = readFileSync(join(cachePath, CACHE_META_FILE), "utf8");
    const meta = JSON.parse(raw) as CachedMaterializeResult;
    if (
      meta.computedDigest !== operation.artifactDigest
      || meta.expectedDigest !== operation.artifactDigest
    ) {
      return false;
    }
    if (!Array.isArray(meta.files) || meta.files.length !== operation.files.length) {
      return false;
    }

    const cachedByPath = new Map(meta.files.map((file) => [file.path, file]));
    const declaredPaths = new Set<string>();
    const actualFiles: Array<{ path: string; sha256: string }> = [];
    for (const file of operation.files) {
      const cached = cachedByPath.get(file.path);
      if (
        !cached
        || cached.sha256.toLowerCase() !== file.sha256.toLowerCase()
        || cached.size !== file.size
        || cached.mode !== file.mode
      ) {
        return false;
      }
      declaredPaths.add(file.path);
      const candidate = join(cachePath, file.path);
      const st = lstatSync(candidate);
      if (
        !st.isFile()
        || st.isSymbolicLink()
        || st.nlink !== 1
        || st.size !== file.size
        || (st.mode & 0o222) !== 0
        || (st.mode & 0o777) !== sealedMode(file.mode)
      ) {
        return false;
      }
      const actual = sha256Hex(readFileBytesNoFollow(candidate));
      if (actual !== file.sha256.toLowerCase()) {
        return false;
      }
      actualFiles.push({ path: file.path, sha256: actual });
    }

    for (const entry of readdirSync(cachePath, { recursive: true, withFileTypes: true })) {
      const rel = relative(cachePath, join(entry.parentPath, entry.name)).replace(/\\/g, "/");
      if (entry.isSymbolicLink()) {
        return false;
      }
      if (entry.isDirectory()) {
        if (![...declaredPaths].some((path) => path.startsWith(`${rel}/`))) {
          return false;
        }
        continue;
      }
      if (!entry.isFile()) {
        return false;
      }
      if (rel !== CACHE_META_FILE && rel !== CACHE_COMPLETE_SENTINEL && !declaredPaths.has(rel)) {
        return false;
      }
    }

    let manifest: SkillArtifactManifest;
    try {
      manifest = JSON.parse(operation.manifestJson) as SkillArtifactManifest;
    } catch {
      return false;
    }
    const actualDigestsSortedByPath = actualFiles
      .sort((left, right) => left.path.localeCompare(right.path, "en-US"))
      .map((file) => file.sha256);
    if (computeArtifactDigest(manifest, actualDigestsSortedByPath) !== operation.artifactDigest) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function sealedMode(mode: string): number {
  return Number.parseInt(mode, 8) & ~0o222;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readFileBytesNoFollow(filePath: string): Uint8Array {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const fd = openSync(filePath, flags);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
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

function copyCachedFiles(
  cachePath: string,
  workDir: string,
  files: ClaimedSkillInstallationOperation["files"],
): void {
  for (const file of files) {
    const sourcePath = join(cachePath, file.path);
    const targetPath = join(workDir, file.path);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, Number.parseInt(file.mode, 8));
  }
}

function discardCacheEntry(cachePath: string): void {
  const discardedPath = `${cachePath}.invalid-${randomUUID()}`;
  try {
    renameSync(cachePath, discardedPath);
  } catch {
    return;
  }
  resetReadOnlyTree(discardedPath);
  rmSync(discardedPath, { recursive: true, force: true });
}

function sealReadOnlyTree(path: string): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) {
    return;
  }
  if (entry.isDirectory()) {
    for (const child of readdirSync(path)) {
      sealReadOnlyTree(join(path, child));
    }
    chmodSync(path, 0o555);
    return;
  }
  chmodSync(path, entry.mode & 0o111 ? 0o555 : 0o444);
}

function resetReadOnlyTree(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) {
    return;
  }
  if (!entry.isDirectory()) {
    chmodSync(path, entry.mode & 0o111 ? 0o755 : 0o644);
    return;
  }
  chmodSync(path, 0o755);
  for (const child of readdirSync(path)) {
    resetReadOnlyTree(join(path, child));
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
