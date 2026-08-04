import {
  insertWorkspaceRuntimeAppReleaseSync,
  listWorkspaceRuntimeAppReleasesSync,
  readWorkspaceRuntimeAppReleaseByVersionSync,
  readWorkspaceRuntimeAppReleaseSync,
  type RuntimeAppArtifactKind,
  type RuntimeAppCatalogItemRecord,
  type WorkspaceRuntimeAppReleaseRecord,
} from "@dofe-agent/db";
import { isWorkspaceAdminOrOwnerSync } from "../runtime-access/runtime-access.ts";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";

const NPM_PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const PYPI_PACKAGE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const NPM_EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PYPI_EXACT_VERSION_PATTERN = /^\d+(?:\.\d+){1,3}(?:[a-z0-9.-]+)?$/i;
const ENTRYPOINT_PATTERN = /^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;

export interface CreateWorkspaceRuntimeAppReleaseInput {
  workspaceId: string;
  actorUserId?: string;
  slug: string;
  displayName: string;
  description?: string;
  category?: string;
  homepage?: string;
  artifactKind: RuntimeAppArtifactKind;
  artifactName: string;
  version: string;
  entryPoint: string;
  fetchImpl?: typeof fetch;
}

export interface WorkspaceRuntimeAppReleaseResult {
  release: WorkspaceRuntimeAppReleaseRecord;
  catalogItem: RuntimeAppCatalogItemRecord;
}

export async function createWorkspaceRuntimeAppRelease(
  input: CreateWorkspaceRuntimeAppReleaseInput,
): Promise<WorkspaceRuntimeAppReleaseResult> {
  assertCanManagePrivateCli(input.workspaceId, input.actorUserId);
  const normalized = normalizeReleaseInput(input);
  if (readWorkspaceRuntimeAppReleaseByVersionSync({
    workspaceId: input.workspaceId,
    slug: normalized.slug,
    version: normalized.version,
  })) throw new Error("runtime_app.release_exists");
  const metadata = await resolveRuntimeAppArtifactMetadata({
    kind: normalized.artifactKind,
    packageName: normalized.artifactName,
    version: normalized.version,
    entryPoint: normalized.entryPoint,
    fetchImpl: input.fetchImpl ?? fetch,
  });
  const release = insertWorkspaceRuntimeAppReleaseSync({
    workspaceId: input.workspaceId,
    slug: normalized.slug,
    displayName: normalized.displayName,
    description: normalized.description,
    category: normalized.category,
    homepage: normalized.homepage,
    version: normalized.version,
    artifactKind: normalized.artifactKind,
    artifactName: normalized.artifactName,
    artifactUrl: metadata.artifactUrl,
    artifactIntegrity: metadata.integrity,
    entryPoint: normalized.entryPoint,
    manifestJson: JSON.stringify({
      schemaVersion: 1,
      package: normalized.artifactName,
      version: normalized.version,
      kind: normalized.artifactKind,
      entrypoints: [normalized.entryPoint],
      artifact: { url: metadata.artifactUrl, integrity: metadata.integrity },
      permissions: { installHosts: metadata.installHosts, taskNetwork: "none", secretFields: [] },
    }),
    risk: "high",
    createdByUserId: input.actorUserId,
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: "Private CLI release published",
    note: `${release.displayName} ${release.version} was published for this workspace.`,
    code: "runtime_app.private_release_published",
    data: {
      actorType: "session_user",
      actorUserId: input.actorUserId,
      resourceType: "runtime_app_release",
      resourceId: release.id,
      artifactKind: release.artifactKind,
      artifactName: release.artifactName,
      version: release.version,
      integrity: release.artifactIntegrity,
    },
  });
  return { release, catalogItem: projectPrivateCliRelease(release) };
}

export function listWorkspaceRuntimeAppCatalogItemsSync(workspaceId: string): RuntimeAppCatalogItemRecord[] {
  return listWorkspaceRuntimeAppReleasesSync(workspaceId).map(projectPrivateCliRelease);
}

export function readWorkspaceRuntimeAppCatalogItemSync(
  workspaceId: string,
  releaseId: string,
): RuntimeAppCatalogItemRecord | null {
  const release = readWorkspaceRuntimeAppReleaseSync(releaseId, workspaceId);
  return release ? projectPrivateCliRelease(release) : null;
}

export function projectPrivateCliRelease(release: WorkspaceRuntimeAppReleaseRecord): RuntimeAppCatalogItemRecord {
  const packageSpec = release.artifactKind === "npm"
    ? { npm_package_spec: `${release.artifactName}@${release.version}` }
    : { pypi_package_spec: `${release.artifactName}==${release.version}` };
  return {
    source: "workspace_private",
    name: release.id,
    displayName: `${release.displayName} ${release.version}`,
    description: release.description,
    version: release.version,
    category: release.category,
    entryPoint: release.entryPoint,
    installStrategy: release.artifactKind === "npm" ? "npm" : "pip",
    installCmd: release.artifactKind === "npm"
      ? `npm install --global ${release.artifactName}@${release.version}`
      : `python3 -m pip install --user ${release.artifactName}==${release.version}`,
    homepage: release.homepage,
    registryJson: JSON.stringify({
      ...packageSpec,
      release_id: release.id,
      package_slug: release.packageSlug,
      artifact_url: release.artifactUrl,
      artifact_integrity: release.artifactIntegrity,
      manifest_json: release.manifestJson,
    }),
    syncedAt: release.createdAt,
  };
}

function assertCanManagePrivateCli(workspaceId: string, actorUserId?: string): void {
  if (!isWorkspaceAdminOrOwnerSync({ workspaceId, userId: actorUserId })) {
    throw new Error("Only workspace owners and admins can publish private CLI releases.");
  }
}

function normalizeReleaseInput(input: CreateWorkspaceRuntimeAppReleaseInput): {
  slug: string;
  displayName: string;
  description: string;
  category: string;
  homepage?: string;
  artifactKind: RuntimeAppArtifactKind;
  artifactName: string;
  version: string;
  entryPoint: string;
} {
  const slug = input.slug.trim().toLowerCase();
  const displayName = input.displayName.trim();
  const artifactName = input.artifactName.trim();
  const version = input.version.trim();
  const entryPoint = input.entryPoint.trim();
  if (!SLUG_PATTERN.test(slug)) throw new Error("runtime_app.private_slug_invalid");
  if (!displayName || displayName.length > 120) throw new Error("runtime_app.private_display_name_invalid");
  const validVersion = input.artifactKind === "npm"
    ? NPM_EXACT_VERSION_PATTERN.test(version)
    : PYPI_EXACT_VERSION_PATTERN.test(version);
  if (!validVersion) throw new Error("runtime_app.release_unpinned");
  if (artifactName.length > 214) throw new Error("runtime_app.package_name_too_long");
  if (input.artifactKind === "npm" && !NPM_PACKAGE_PATTERN.test(artifactName)) throw new Error("runtime_app.npm_package_invalid");
  if (input.artifactKind === "pypi" && !PYPI_PACKAGE_PATTERN.test(artifactName)) throw new Error("runtime_app.pypi_package_invalid");
  if (input.artifactKind !== "npm" && input.artifactKind !== "pypi") throw new Error("runtime_app.artifact_kind_invalid");
  if (!ENTRYPOINT_PATTERN.test(entryPoint)) throw new Error("runtime_app.entrypoint_invalid");
  return {
    slug,
    displayName,
    description: (input.description ?? "").trim().slice(0, 600),
    category: (input.category ?? "other").trim().slice(0, 64) || "other",
    homepage: normalizeHttpsUrl(input.homepage),
    artifactKind: input.artifactKind,
    artifactName,
    version,
    entryPoint,
  };
}

export async function resolveRuntimeAppArtifactMetadata(input: {
  kind: RuntimeAppArtifactKind;
  packageName: string;
  version: string;
  entryPoint: string;
  fetchImpl: typeof fetch;
}): Promise<{ artifactUrl: string; integrity: string; installHosts: string[] }> {
  const { kind, packageName, version, entryPoint, fetchImpl } = input;
  if (kind === "npm") {
    const metadata = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`, fetchImpl);
    const metadataRecord = asRecord(metadata);
    const dist = asRecord(metadataRecord.dist);
    const integrity = readString(dist.integrity);
    const artifactUrl = readString(dist.tarball);
    if (!/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(integrity) || !isAllowedHttpsUrl(artifactUrl, "registry.npmjs.org")) {
      throw new Error("runtime_app.artifact_integrity_missing");
    }
    if (readString(metadataRecord.version) !== version || readString(metadataRecord.deprecated)) {
      throw new Error("runtime_app.release_unavailable");
    }
    const bin = metadataRecord.bin;
    const declaredEntrypoints = typeof bin === "string"
      ? [packageName.split("/").at(-1) ?? packageName]
      : Object.keys(asRecord(bin));
    if (!declaredEntrypoints.includes(entryPoint)) throw new Error("runtime_app.entrypoint_not_declared");
    return { artifactUrl, integrity, installHosts: ["registry.npmjs.org"] };
  }
  const metadata = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}/json`, fetchImpl);
  const metadataRecord = asRecord(metadata);
  const info = asRecord(metadataRecord.info);
  if (readString(info.version) !== version) throw new Error("runtime_app.release_unavailable");
  const urls: unknown[] = Array.isArray(metadataRecord.urls) ? metadataRecord.urls : [];
  const candidate = urls
    .map(asRecord)
    .find((item) => item.yanked !== true && isAllowedHttpsUrl(readString(item.url), "files.pythonhosted.org"));
  const digests = asRecord(candidate?.digests);
  const integrity = readString(digests.sha256);
  const artifactUrl = readString(candidate?.url);
  if (!/^[a-f0-9]{64}$/i.test(integrity) || !artifactUrl) throw new Error("runtime_app.artifact_integrity_missing");
  return { artifactUrl, integrity: `sha256-${integrity}`, installHosts: ["pypi.org", "files.pythonhosted.org"] };
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchImpl(url, { redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error("runtime_app.release_unavailable");
    const text = await response.text();
    if (text.length > MAX_METADATA_BYTES) throw new Error("runtime_app.metadata_too_large");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("runtime_app.metadata_invalid");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("runtime_app.")) throw error;
    throw new Error("runtime_app.registry_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeHttpsUrl(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && isAllowedHttpsUrl(text) ? text : undefined;
}

function isAllowedHttpsUrl(value: string, hostname?: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (!hostname || url.hostname === hostname);
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
