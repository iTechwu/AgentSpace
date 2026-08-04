import { getDatabase, randomLikeId, withTransaction } from "./database.ts";
import type {
  RuntimeAppArtifactKind,
  RuntimeAppRiskLevel,
  WorkspaceRuntimeAppPackageRecord,
  WorkspaceRuntimeAppReleaseRecord,
} from "./types.ts";

export interface InsertWorkspaceRuntimeAppReleaseInput {
  workspaceId: string;
  slug: string;
  displayName: string;
  description?: string;
  category?: string;
  homepage?: string;
  version: string;
  artifactKind: RuntimeAppArtifactKind;
  artifactName: string;
  artifactUrl: string;
  artifactIntegrity: string;
  entryPoint: string;
  manifestJson: string;
  risk?: RuntimeAppRiskLevel;
  createdByUserId?: string;
}

export function insertWorkspaceRuntimeAppReleaseSync(
  input: InsertWorkspaceRuntimeAppReleaseInput,
): WorkspaceRuntimeAppReleaseRecord {
  const db = getDatabase();
  const now = new Date().toISOString();
  const packageId = `runtime-app-package-${randomLikeId()}`;
  const releaseId = `runtime-app-release-${randomLikeId()}`;
  withTransaction(db, () => {
    db.prepare(
      `INSERT INTO runtime_app_package (
        id, workspace_id, slug, display_name, description, category, homepage, created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, slug) DO NOTHING`,
    ).run(
      packageId,
      input.workspaceId,
      input.slug,
      input.displayName,
      input.description ?? "",
      input.category ?? "other",
      input.homepage ?? null,
      input.createdByUserId ?? null,
      now,
    );
    const runtimePackage = readWorkspaceRuntimeAppPackageBySlugSync(input.workspaceId, input.slug);
    if (!runtimePackage) throw new Error("runtime_app.package_create_failed");
    db.prepare(
      `INSERT INTO runtime_app_release (
        id, workspace_id, package_id, version, artifact_kind, artifact_name, artifact_url,
        artifact_integrity, entry_point, manifest_json, risk, created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      releaseId,
      input.workspaceId,
      runtimePackage.id,
      input.version,
      input.artifactKind,
      input.artifactName,
      input.artifactUrl,
      input.artifactIntegrity,
      input.entryPoint,
      input.manifestJson,
      input.risk ?? "high",
      input.createdByUserId ?? null,
      now,
    );
  });
  const release = readWorkspaceRuntimeAppReleaseSync(releaseId, input.workspaceId);
  if (!release) throw new Error("runtime_app.release_create_failed");
  return release;
}

export function readWorkspaceRuntimeAppPackageBySlugSync(
  workspaceId: string,
  slug: string,
): WorkspaceRuntimeAppPackageRecord | null {
  const row = getDatabase().prepare(
    `SELECT id, workspace_id AS workspaceId, slug, display_name AS displayName, description,
            category, homepage, created_by_user_id AS createdByUserId, created_at AS createdAt
     FROM runtime_app_package WHERE workspace_id = ? AND slug = ?`,
  ).get(workspaceId, slug) as Record<string, unknown> | undefined;
  return row ? mapPackage(row) : null;
}

export function readWorkspaceRuntimeAppReleaseByVersionSync(input: {
  workspaceId: string;
  slug: string;
  version: string;
}): WorkspaceRuntimeAppReleaseRecord | null {
  const row = getDatabase().prepare(`${RELEASE_SELECT} WHERE r.workspace_id = ? AND p.slug = ? AND r.version = ?`)
    .get(input.workspaceId, input.slug, input.version) as Record<string, unknown> | undefined;
  return row ? mapRelease(row) : null;
}

export function readWorkspaceRuntimeAppReleaseSync(
  releaseId: string,
  workspaceId: string,
): WorkspaceRuntimeAppReleaseRecord | null {
  const row = getDatabase().prepare(`${RELEASE_SELECT} WHERE r.id = ? AND r.workspace_id = ?`)
    .get(releaseId, workspaceId) as Record<string, unknown> | undefined;
  return row ? mapRelease(row) : null;
}

export function listWorkspaceRuntimeAppReleasesSync(
  workspaceId: string,
  options: { includeYanked?: boolean; limit?: number } = {},
): WorkspaceRuntimeAppReleaseRecord[] {
  const limit = Math.max(1, Math.min(options.limit ?? 500, 1000));
  const rows = getDatabase().prepare(
    `${RELEASE_SELECT} WHERE r.workspace_id = ? ${options.includeYanked ? "" : "AND r.yanked_at IS NULL"}
     ORDER BY r.created_at DESC LIMIT ${limit}`,
  ).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapRelease).filter((value): value is WorkspaceRuntimeAppReleaseRecord => value !== null);
}

const RELEASE_SELECT = `SELECT
  r.id, r.workspace_id AS workspaceId, r.package_id AS packageId, p.slug AS packageSlug,
  p.display_name AS displayName, p.description, p.category, p.homepage,
  r.version, r.artifact_kind AS artifactKind, r.artifact_name AS artifactName,
  r.artifact_url AS artifactUrl, r.artifact_integrity AS artifactIntegrity,
  r.entry_point AS entryPoint, r.manifest_json AS manifestJson, r.risk,
  r.created_by_user_id AS createdByUserId, r.created_at AS createdAt, r.yanked_at AS yankedAt
 FROM runtime_app_release r
 JOIN runtime_app_package p ON p.id = r.package_id`;

function mapPackage(value: Record<string, unknown>): WorkspaceRuntimeAppPackageRecord | null {
  if (
    typeof value.id !== "string" || typeof alias(value, "workspaceId", "workspaceid") !== "string" || typeof value.slug !== "string"
    || typeof alias(value, "displayName", "displayname") !== "string" || typeof value.description !== "string"
    || typeof value.category !== "string" || typeof alias(value, "createdAt", "createdat") !== "string"
  ) return null;
  return {
    id: value.id,
    workspaceId: alias(value, "workspaceId", "workspaceid") as string,
    slug: value.slug,
    displayName: alias(value, "displayName", "displayname") as string,
    description: value.description,
    category: value.category,
    homepage: optionalString(value.homepage),
    createdByUserId: optionalString(value.createdByUserId),
    createdAt: alias(value, "createdAt", "createdat") as string,
  };
}

function mapRelease(value: Record<string, unknown>): WorkspaceRuntimeAppReleaseRecord | null {
  const workspaceId = alias(value, "workspaceId", "workspaceid");
  const packageId = alias(value, "packageId", "packageid");
  const packageSlug = alias(value, "packageSlug", "packageslug");
  const displayName = alias(value, "displayName", "displayname");
  const artifactKind = alias(value, "artifactKind", "artifactkind");
  const artifactName = alias(value, "artifactName", "artifactname");
  const artifactUrl = alias(value, "artifactUrl", "artifacturl");
  const artifactIntegrity = alias(value, "artifactIntegrity", "artifactintegrity");
  const entryPoint = alias(value, "entryPoint", "entrypoint");
  const manifestJson = alias(value, "manifestJson", "manifestjson");
  const createdAt = alias(value, "createdAt", "createdat");
  if (
    typeof value.id !== "string" || typeof workspaceId !== "string" || typeof packageId !== "string"
    || typeof packageSlug !== "string" || typeof displayName !== "string"
    || typeof value.description !== "string" || typeof value.category !== "string"
    || typeof value.version !== "string" || !isArtifactKind(artifactKind)
    || typeof artifactName !== "string" || typeof artifactUrl !== "string"
    || typeof artifactIntegrity !== "string" || typeof entryPoint !== "string"
    || typeof manifestJson !== "string" || !isRisk(value.risk) || typeof createdAt !== "string"
  ) return null;
  return {
    id: value.id,
    workspaceId,
    packageId,
    packageSlug,
    displayName,
    description: value.description,
    category: value.category,
    homepage: optionalString(value.homepage),
    version: value.version,
    artifactKind,
    artifactName,
    artifactUrl,
    artifactIntegrity,
    entryPoint,
    manifestJson,
    risk: value.risk,
    createdByUserId: optionalString(value.createdByUserId),
    createdAt,
    yankedAt: optionalString(alias(value, "yankedAt", "yankedat")),
  };
}

function alias(value: Record<string, unknown>, camel: string, lower: string): unknown {
  return value[camel] ?? value[lower];
}

function isArtifactKind(value: unknown): value is RuntimeAppArtifactKind {
  return value === "npm" || value === "pypi";
}

function isRisk(value: unknown): value is RuntimeAppRiskLevel {
  return value === "low" || value === "medium" || value === "high";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
