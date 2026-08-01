import { createHash } from "node:crypto";
import type { DspManifest } from "@dofe-agent/domain";
import { SKILL_ARTIFACT_DIGEST_PREFIX } from "@dofe-agent/domain";

/**
 * Canonical artifact digest.
 *
 * Per 02-架构设计.md §2: the root digest is the hash of the canonical manifest
 * plus the path-sorted file digests. Provenance (source URL, commit SHA,
 * importer) is deliberately EXCLUDED so that the same logical skill imported
 * from a directory, a ZIP, or Git yields the same digest.
 *
 * Implementation: the manifest's `files` already carry each file's sha256, size,
 * mode and mediaType. We canonicalize the whole manifest (sorted keys, files
 * sorted by path, `artifact.sha256` cleared to avoid self-reference) and hash
 * its stable JSON serialization.
 */

/**
 * Compute the canonical artifact digest for a validated manifest.
 * The manifest's `files` array is sorted by path before hashing; the caller's
 * `artifact.sha256` is ignored (cleared) so the digest is not self-referential.
 */
export function computeArtifactDigest(manifest: DspManifest): string {
  const canonical = toCanonicalManifest(manifest);
  const serialized = stableStringify(canonical);
  const hash = createHash("sha256").update(serialized, "utf8").digest("hex");
  return `${SKILL_ARTIFACT_DIGEST_PREFIX}${hash}`;
}

/** SHA-256 hex of raw bytes (without the `sha256:` prefix). */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface CanonicalManifest {
  schemaVersion: number;
  artifact: { name: string; version: string };
  files: Array<{ path: string; sha256: string; size: number; mediaType: string; mode?: string }>;
  dependencies?: unknown[];
  capabilities?: unknown[];
  services?: unknown[];
  entrypoints?: unknown[];
}

function toCanonicalManifest(manifest: DspManifest): CanonicalManifest {
  // Deterministic code-unit ordering (not locale-sensitive) so the digest is
  // stable across platforms and ICU versions.
  const files = [...manifest.files].sort(compareByPath);
  return {
    schemaVersion: manifest.schemaVersion,
    artifact: {
      name: manifest.artifact.name,
      version: manifest.artifact.version,
    },
    files: files.map((entry) => ({
      path: entry.path,
      sha256: entry.sha256,
      size: entry.size,
      mediaType: entry.mediaType,
      ...(entry.mode ? { mode: entry.mode } : {}),
    })),
    ...(manifest.dependencies ? { dependencies: manifest.dependencies } : {}),
    ...(manifest.capabilities ? { capabilities: manifest.capabilities } : {}),
    ...(manifest.services ? { services: manifest.services } : {}),
    ...(manifest.entrypoints ? { entrypoints: manifest.entrypoints } : {}),
  };
}

/** Deterministic JSON: object keys sorted recursively, arrays order preserved. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Code-unit (UTF-16) comparison — locale-independent, stable across runtimes. */
function compareByPath<T extends { path: string }>(left: T, right: T): number {
  if (left.path < right.path) {
    return -1;
  }
  if (left.path > right.path) {
    return 1;
  }
  return 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize(record[key]);
        return acc;
      }, {});
  }
  return value;
}
