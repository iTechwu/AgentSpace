import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ClaimedSkillInstallationOperation,
  SkillInstallationOperationFile,
} from "@dofe-agent/domain";
import {
  computeArtifactDigest,
  type SkillArtifactManifest,
} from "@dofe-agent/services";
import { resolveAttachmentRuntimeConfig } from "@dofe-agent/services";

const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export interface MaterializedSkillFile {
  path: string;
  sha256: string;
  size: number;
}

export interface MaterializeResult {
  files: MaterializedSkillFile[];
  rootDigestMatches: boolean;
  computedDigest: string;
  expectedDigest: string;
}

export class SkillMaterializationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SkillMaterializationError";
  }
}

/**
 * Downloads/decodes an artifact file from the claim payload and writes it into
 * `targetDir` while preserving the executable bit and verifying per-file sha256.
 *
 * Files are sourced from `downloadUrl` (remote TOS/signed URL) when present;
 * otherwise `storedPath` is parsed for local blob access. This lets the same
 * materializer work in production (short-lived URLs) and local tests (direct
 * filesystem blob store).
 */
export async function materializeSkillInstallationArtifact(
  operation: ClaimedSkillInstallationOperation,
  targetDir: string,
): Promise<MaterializeResult> {
  mkdirSync(targetDir, { recursive: true });

  const manifest = parseManifestJson(operation.manifestJson);
  const fileDigests: string[] = [];
  const materialized: MaterializedSkillFile[] = [];
  const errors: string[] = [];

  for (const file of operation.files) {
    try {
      const bytes = await fetchFileBytes(file, operation.workspaceId);
      const actualSha256 = sha256Hex(bytes);
      if (actualSha256 !== file.sha256.toLowerCase()) {
        throw new SkillMaterializationError(
          `File "${file.path}" digest mismatch: expected ${file.sha256}, got ${actualSha256}`,
          "skill_installation.file_digest_mismatch",
        );
      }
      if (bytes.byteLength !== file.size) {
        throw new SkillMaterializationError(
          `File "${file.path}" size mismatch: expected ${file.size}, got ${bytes.byteLength}`,
          "skill_installation.file_size_mismatch",
        );
      }

      const targetPath = resolveMaterializePath(targetDir, file.path);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, bytes);
      if (file.mode === "0755") {
        chmodSync(targetPath, 0o755);
      }

      fileDigests.push(actualSha256);
      materialized.push({ path: file.path, sha256: actualSha256, size: bytes.byteLength });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`"${file.path}": ${message}`);
    }
  }

  if (errors.length > 0) {
    throw new SkillMaterializationError(
      `Artifact materialization failed:\n${errors.join("\n")}`,
      "skill_installation.materialization_failed",
    );
  }

  const computedDigest = computeArtifactDigest(manifest, fileDigests);
  const rootDigestMatches = computedDigest === operation.artifactDigest;

  return {
    files: materialized,
    rootDigestMatches,
    computedDigest,
    expectedDigest: operation.artifactDigest,
  };
}

async function fetchFileBytes(file: SkillInstallationOperationFile, workspaceId: string): Promise<Uint8Array> {
  if (file.downloadUrl) {
    return downloadWithTimeout(file.downloadUrl, file.size);
  }
  if (file.storedPath?.startsWith("local:///")) {
    return readLocalBlobBytes(file.storedPath, workspaceId);
  }
  if (file.storedPath?.startsWith("tos://")) {
    throw new SkillMaterializationError(
      `File "${file.path}" has no downloadUrl and cannot be fetched from TOS without credentials`,
      "skill_installation.missing_download_url",
    );
  }
  throw new SkillMaterializationError(
    `File "${file.path}" has no downloadUrl or storedPath`,
    "skill_installation.missing_file_source",
  );
}

async function downloadWithTimeout(url: string, expectedSize: number): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength) {
      const length = Number.parseInt(contentLength, 10);
      if (Number.isFinite(length) && length > Math.max(expectedSize * 2, MAX_DOWNLOAD_BYTES)) {
        throw new Error(`Response size ${length} exceeds guard limit`);
      }
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

function readLocalBlobBytes(storedPath: string, workspaceId: string): Uint8Array {
  const config = resolveAttachmentRuntimeConfig();
  if (config.provider !== "local") {
    throw new Error("Local blob fallback requested but attachment runtime config is not local");
  }
  const key = storedPath.slice("local:///".length);
  const targetPath = resolve(config.localRoot, key);
  const rel = relative(config.localRoot, targetPath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Local blob path escapes the configured attachment root");
  }
  return new Uint8Array(readFileSync(targetPath));
}

function resolveMaterializePath(targetDir: string, filePath: string): string {
  const candidate = filePath.trim();
  if (!candidate) {
    throw new SkillMaterializationError("File path is required", "skill_installation.empty_file_path");
  }
  if (isAbsolute(candidate)) {
    throw new SkillMaterializationError(
      `File path must be relative: ${candidate}`,
      "skill_installation.absolute_file_path",
    );
  }
  const resolvedPath = resolve(targetDir, candidate);
  const rel = relative(targetDir, resolvedPath);
  if (!rel || rel === "." || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return resolvedPath;
  }
  throw new SkillMaterializationError(
    `File path escapes target directory: ${candidate}`,
    "skill_installation.path_traversal",
  );
}

function parseManifestJson(manifestJson: string): SkillArtifactManifest {
  try {
    return JSON.parse(manifestJson) as SkillArtifactManifest;
  } catch {
    throw new SkillMaterializationError(
      "Artifact manifest JSON is invalid",
      "skill_installation.invalid_manifest_json",
    );
  }
}

function sha256Hex(bytes: Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(bytes);
  return hash.digest("hex");
}

export function normalizeScriptInterpreter(filePath: string, mode: string): string | null {
  if (mode !== "0755") {
    return null;
  }
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".sh")) return "sh";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "node";
  if (lower.endsWith(".ts") || lower.endsWith(".mts")) return "node";
  if (lower.endsWith(".py")) return "python";
  return null;
}
