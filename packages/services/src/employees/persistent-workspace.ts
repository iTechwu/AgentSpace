import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  assertEmployeeBindingGenerationSync,
  commitWorkspaceRevisionSync,
  createWorkspaceRevisionSync,
  ensureEmployeePersistentWorkspaceSync,
  listEmployeeArtifactDigestsSync,
  listEmployeeArtifactsSync,
  listOrphanContentBlobsSync,
  listSkillArtifactFileDigestsSync,
  listWorkspaceRevisionDigestsSync,
  publishEmployeeArtifactSync,
  readEmployeePersistentWorkspaceSync,
  readHeadRevisionSync,
  readWorkspaceRevisionSync,
  restoreWorkspaceRevisionSync,
  softDeleteEmployeeArtifactSync,
  upsertContentBlobSync,
  deleteContentBlobSync,
  type EmployeeArtifactRecord,
  type EmployeePersistentWorkspaceRecord,
  type EmployeeWorkspaceRevisionRecord,
} from "@dofe-agent/db";
import { createAttachmentStorageClient, sha256Hex } from "../attachments/storage.ts";
import { mediaTypeForPath } from "../skills/skill-artifacts.ts";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface WorkspaceRevisionFileEntry {
  path: string;
  sha256: string;
  size: number;
  mediaType: string;
  /** Octal permission string, e.g. "0755" / "0644" (preserved on restore). */
  mode?: string;
}

export interface WorkspaceRevisionManifest {
  taskId?: string;
  files: WorkspaceRevisionFileEntry[];
}

export interface TaskOutputFile {
  path: string;
  bytes: Uint8Array;
  mediaType?: string;
  /** Octal permission string, e.g. "0755" / "0644". */
  mode?: string;
}

/** True when a promoted path came from the daemon's bounded workDir capture. */
export function isWorkDirCapturePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return (
    normalized.startsWith("repository/") ||
    normalized.startsWith("state/") ||
    normalized.startsWith("artifacts/") ||
    normalized.startsWith("checkpoints/")
  );
}

export interface PromoteTaskOutputsResult {
  revision: EmployeeWorkspaceRevisionRecord;
  artifactIds: string[];
  created: boolean;
}

export function restoreValidatedWorkspaceRevisionSync(input: {
  workspaceId?: string;
  employeeName: string;
  targetRevisionId: string;
  actorUserId: string;
  actorDisplayName: string;
}): EmployeeWorkspaceRevisionRecord {
  const workspaceId = input.workspaceId ?? "default";
  const target = readWorkspaceRevisionSync(input.targetRevisionId, workspaceId);
  if (!target) {
    throw new Error(`Target revision "${input.targetRevisionId}" does not exist.`);
  }
  let manifest: WorkspaceRevisionManifest;
  try {
    manifest = JSON.parse(target.manifestJson) as WorkspaceRevisionManifest;
  } catch {
    throw new Error(`Target revision "${target.id}" has an invalid manifest.`);
  }
  if (!Array.isArray(manifest.files) || computeRevisionManifestDigest(manifest) !== target.manifestDigest) {
    throw new Error(`Target revision "${target.id}" manifest digest verification failed.`);
  }
  const seenPaths = new Set<string>();
  const storage = createAttachmentStorageClient();
  for (const file of manifest.files) {
    const normalizedPath = file && typeof file.path === "string"
      ? normalizeWorkspaceRevisionPath(file.path, `Target revision "${target.id}" file path`)
      : undefined;
    if (
      !file || !normalizedPath || file.path !== normalizedPath || seenPaths.has(normalizedPath)
      || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(file.sha256)
      || !Number.isSafeInteger(file.size) || file.size < 0
      || typeof file.mediaType !== "string"
    ) {
      throw new Error(`Target revision "${target.id}" contains an invalid or duplicate file entry.`);
    }
    seenPaths.add(normalizedPath);
    const bytes = storage.getContentAddressedBlobSync({ workspaceId, sha256: file.sha256 });
    if (sha256Hex(bytes) !== file.sha256.toLowerCase() || bytes.byteLength !== file.size) {
      throw new Error(`Target revision "${target.id}" blob verification failed for "${file.path}".`);
    }
  }
  return restoreWorkspaceRevisionSync({
    workspaceId,
    employeeName: input.employeeName,
    targetRevisionId: target.id,
    createdBy: input.actorUserId,
    audit: {
      actorId: input.actorUserId,
      actorDisplayName: input.actorDisplayName,
    },
  });
}

function mergeManifestFiles(
  parentFiles: WorkspaceRevisionFileEntry[],
  newFiles: WorkspaceRevisionFileEntry[],
): WorkspaceRevisionFileEntry[] {
  const byPath = new Map<string, WorkspaceRevisionFileEntry>();
  for (const file of parentFiles) {
    byPath.set(file.path, file);
  }
  for (const file of newFiles) {
    byPath.set(file.path, file);
  }
  return Array.from(byPath.values());
}

function parseRevisionManifestFiles(manifestJson: string): WorkspaceRevisionFileEntry[] {
  try {
    const manifest = JSON.parse(manifestJson) as WorkspaceRevisionManifest;
    if (!Array.isArray(manifest.files)) {
      throw new Error("Workspace revision manifest is missing its files array.");
    }
    const seenPaths = new Set<string>();
    return manifest.files.map((file) => {
      if (
        !file || typeof file.path !== "string" ||
        typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(file.sha256) ||
        !Number.isSafeInteger(file.size) || file.size < 0 ||
        typeof file.mediaType !== "string" || !file.mediaType.trim()
      ) {
        throw new Error("Workspace revision manifest contains an invalid file entry.");
      }
      const path = normalizeWorkspaceRevisionPath(file.path, "Workspace revision file path");
      if (path !== file.path || seenPaths.has(path)) {
        throw new Error("Workspace revision manifest contains a non-canonical or duplicate path.");
      }
      seenPaths.add(path);
      return { ...file, path, sha256: file.sha256.toLowerCase() };
    });
  } catch (error) {
    throw new Error(
      `Workspace revision manifest is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function normalizeWorkspaceRevisionPath(value: string, label: string): string {
  const candidate = value.trim().replace(/\\/g, "/");
  if (
    !candidate || candidate.includes("\0") || candidate.startsWith("/") ||
    isAbsolute(candidate) || /^[A-Za-z]:\//.test(candidate)
  ) {
    throw new Error(`${label} must be a non-empty relative path.`);
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an unsafe path segment: ${value}`);
  }
  return segments.join("/");
}

/* ------------------------------------------------------------------ */
/* Promote task outputs → persistent workspace revision                 */
/* ------------------------------------------------------------------ */

/**
 * Promotes a task's durable outputs into the employee's persistent workspace
 * as an immutable, content-addressed revision. Idempotent by (task, content):
 * re-running a recovered task produces the same manifest digest and returns
 * the existing revision rather than publishing a duplicate (EAD §7, D-05).
 *
 * Formal artifacts (publishArtifact=true) are also published as
 * employee_artifact rows referencing the same content-addressed blobs.
 */
export function promoteTaskOutputsToWorkspaceSync(input: {
  workspaceId?: string;
  taskId: string;
  employeeName: string;
  outputs: TaskOutputFile[];
  publishArtifacts?: boolean;
  createdBy?: string;
  /** Paths the provider deleted this task; the merged revision drops them (tombstone). */
  deletedPaths?: string[];
  /** Write-lease guard: when provided, the binding generation must EXACTLY equal this value. */
  expectedBindingGeneration?: number;
}): PromoteTaskOutputsResult {
  const workspaceId = input.workspaceId ?? "default";
  const employeeName = input.employeeName.trim();
  if (!employeeName) {
    throw new Error("Employee name is required to promote task outputs.");
  }
  // Split-brain write guard (EAD-005): refuse to publish into a workspace whose
  // binding lease is no longer current.
  if (input.expectedBindingGeneration !== undefined) {
    assertEmployeeBindingGenerationSync(employeeName, input.expectedBindingGeneration, workspaceId);
  }

  const workspace = ensureEmployeePersistentWorkspaceSync({ workspaceId, employeeName });
  const head = readHeadRevisionSync(employeeName, workspaceId);
  const storage = createAttachmentStorageClient();

  const manifestFiles: WorkspaceRevisionFileEntry[] = [];
  const artifactIds: string[] = [];

  for (const output of input.outputs) {
    const path = normalizeWorkspaceRevisionPath(output.path, "Task output path");
    const sha256 = sha256Hex(output.bytes);
    const mediaType = output.mediaType ?? mediaTypeForPath(path);
    const size = output.bytes.byteLength;

    // Upload content-addressed blob (idempotent at the storage layer — Local
    // skips an existing blob, TOS overwrites safely). The returned ref carries
    // the ACTUAL provider/bucket/region/endpoint/key so recovery, migration
    // and audit can locate the object reliably.
    const ref = storage.putContentAddressedBlobSync({ workspaceId, sha256, contentBytes: output.bytes, mediaType });
    upsertContentBlobSync({
      workspaceId,
      sha256,
      storageProvider: ref.storageProvider,
      storageBucket: ref.storageBucket,
      storageRegion: ref.storageRegion,
      storageEndpoint: ref.storageEndpoint,
      storageKey: ref.storageKey,
      sizeBytes: size,
      mediaType,
    });

    manifestFiles.push({ path, sha256, size, mediaType, mode: output.mode });

    if (input.publishArtifacts && !isWorkDirCapturePath(path)) {
      // Only explicitly declared formal outputs become employee_artifacts.
      // WorkDir snapshot files (repository/state/artifacts) are workspace
      // content promoted into the revision, NOT published artifacts — a source
      // file or state blob must not surface as a formal deliverable.
      const artifact = publishEmployeeArtifactSync({
        workspaceId,
        employeeName,
        contentDigest: sha256,
        mediaType,
        fileName: path.split("/").pop() || path,
        sizeBytes: size,
        sourceTaskId: input.taskId,
      });
      artifactIds.push(artifact.id);
    }
  }

  // FULL-SNAPSHOT model (EAD-003): each revision's manifest is the complete file
  // set — parent revision's files merged with this task's outputs (newer path
  // wins), minus the paths the provider deleted this task (tombstones). The head
  // revision alone is sufficient to restore the whole workspace, independent of
  // the revision chain.
  const parentFiles = head ? parseRevisionManifestFiles(head.manifestJson) : [];
  const mergedFiles = mergeManifestFiles(parentFiles, manifestFiles);
  const deleted = new Set(
    (input.deletedPaths ?? []).map((path) => normalizeWorkspaceRevisionPath(path, "Deleted workspace path")),
  );
  const finalFiles = deleted.size > 0
    ? mergedFiles.filter((file) => !deleted.has(file.path))
    : mergedFiles;
  const manifest: WorkspaceRevisionManifest = {
    taskId: input.taskId,
    files: finalFiles.sort((left, right) => left.path.localeCompare(right.path, "en-US")),
  };
  const manifestDigest = computeRevisionManifestDigest(manifest);

  // A revision whose manifest contains any workDir-captured path is a
  // `workdir_snapshot`; otherwise it is an explicit `task_output` promotion.
  const sourceKind = manifestFiles.some((file) => isWorkDirCapturePath(file.path))
    ? "workdir_snapshot"
    : "task_output";

  // createWorkspaceRevisionSync is idempotent on (workspace, manifestDigest).
  const revision = createWorkspaceRevisionSync({
    workspaceId,
    employeeName,
    parentRevisionId: head?.id,
    manifestDigest,
    manifestJson: JSON.stringify(manifest),
    sourceTaskId: input.taskId,
    status: "pending",
    sourceKind,
    createdBy: input.createdBy,
  });

  const wasCreated = revision.status === "pending";
  const committed = wasCreated
    ? commitWorkspaceRevisionSync(revision.id, workspaceId)
    : revision;

  return {
    revision: committed,
    artifactIds,
    created: wasCreated,
  };
}

/**
 * Publishes a single formal artifact (report, code package, presentation) to
 * the employee's persistent workspace. The bytes become a content-addressed
 * blob; the employee_artifact row is the published reference.
 */
export function promoteArtifactSync(input: {
  workspaceId?: string;
  employeeName: string;
  fileName: string;
  bytes: Uint8Array;
  mediaType?: string;
  sourceTaskId?: string;
}): { artifact: EmployeeArtifactRecord; digest: string } {
  const workspaceId = input.workspaceId ?? "default";
  ensureEmployeePersistentWorkspaceSync({ workspaceId, employeeName: input.employeeName });
  const storage = createAttachmentStorageClient();
  const sha256 = sha256Hex(input.bytes);
  const mediaType = input.mediaType ?? mediaTypeForPath(input.fileName);

  // Idempotent upload; the returned ref carries the real provider/bucket/key.
  const ref = storage.putContentAddressedBlobSync({ workspaceId, sha256, contentBytes: input.bytes, mediaType });
  upsertContentBlobSync({
    workspaceId,
    sha256,
    storageProvider: ref.storageProvider,
    storageBucket: ref.storageBucket,
    storageRegion: ref.storageRegion,
    storageEndpoint: ref.storageEndpoint,
    storageKey: ref.storageKey,
    sizeBytes: input.bytes.byteLength,
    mediaType,
  });

  const artifact = publishEmployeeArtifactSync({
    workspaceId,
    employeeName: input.employeeName,
    contentDigest: sha256,
    mediaType,
    fileName: input.fileName,
    sizeBytes: input.bytes.byteLength,
    sourceTaskId: input.sourceTaskId,
  });
  return { artifact, digest: sha256 };
}

/* ------------------------------------------------------------------ */
/* Orphan blob reclamation                                             */
/* ------------------------------------------------------------------ */

export interface OrphanBlobScanResult {
  orphanCount: number;
  reclaimedCount: number;
  orphans: Array<{ sha256: string; storageKey: string }>;
}

/**
 * Scans for content blobs no longer referenced by any skill artifact,
 * committed workspace revision, or live employee artifact, and (optionally)
 * deletes them. Per EAD §10 / P2-step-5: delayed reclamation with a grace
 * window so in-flight uploads are not collected.
 */
export function reclaimOrphanContentBlobsSync(input: {
  workspaceId?: string;
  retainRecentSeconds?: number;
  now?: string;
  delete?: boolean;
  limit?: number;
}): OrphanBlobScanResult {
  const workspaceId = input.workspaceId ?? "default";

  const orphans = listOrphanContentBlobsSync(
    workspaceId,
    {
      skillArtifactFileDigests: listSkillArtifactFileDigestsSync(workspaceId),
      workspaceRevisionDigests: listWorkspaceRevisionDigestsSync(workspaceId),
      employeeArtifactDigests: listEmployeeArtifactDigestsSync(workspaceId),
    },
    {
      retainRecentSeconds: input.retainRecentSeconds ?? 3600,
      now: input.now,
      limit: input.limit ?? 500,
    },
  );

  let reclaimedCount = 0;
  if (input.delete) {
    for (const orphan of orphans) {
      if (deleteContentBlobSync(orphan.sha256, workspaceId)) {
        reclaimedCount += 1;
      }
    }
  }

  return {
    orphanCount: orphans.length,
    reclaimedCount,
    orphans: orphans.map((blob) => ({ sha256: blob.sha256, storageKey: blob.storageKey })),
  };
}

/* ------------------------------------------------------------------ */
/* Read helpers (for UI / data-protection panel)                        */
/* ------------------------------------------------------------------ */

export interface EmployeeDataProtectionSnapshot {
  workspace: EmployeePersistentWorkspaceRecord | null;
  headRevision: EmployeeWorkspaceRevisionRecord | null;
  recentArtifacts: EmployeeArtifactRecord[];
}

export function readEmployeeDataProtectionSnapshotSync(input: {
  workspaceId?: string;
  employeeName: string;
}): EmployeeDataProtectionSnapshot {
  const workspaceId = input.workspaceId ?? "default";
  const workspace = readEmployeePersistentWorkspaceSync(input.employeeName, workspaceId);
  return {
    workspace,
    headRevision: workspace ? readHeadRevisionSync(input.employeeName, workspaceId) : null,
    recentArtifacts: listEmployeeArtifactsSync({ employeeName: input.employeeName, workspaceId, limit: 10 }),
  };
}

export { softDeleteEmployeeArtifactSync };

/* ------------------------------------------------------------------ */
/* Digest                                                              */
/* ------------------------------------------------------------------ */

/**
 * Revision manifest digest = sha256 of canonical (keys-sorted, no-whitespace)
 * JSON of {taskId, files sorted by path}. Excludes timestamps and parent so
 * re-running a recovered task yields the same digest → idempotent publish.
 */
export function computeRevisionManifestDigest(manifest: WorkspaceRevisionManifest): string {
  const canonical = stableStringify({
    taskId: manifest.taskId ?? "",
    files: manifest.files
      .slice()
      .sort((left, right) => left.path.localeCompare(right.path, "en-US"))
      .map((entry) => ({ path: entry.path, sha256: entry.sha256, size: entry.size, mediaType: entry.mediaType })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
