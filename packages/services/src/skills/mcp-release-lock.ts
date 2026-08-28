import { createHash } from "node:crypto";
import { listMcpCatalogItemReleasesSync } from "@dofe-agent/db";
import { stableStringify } from "./package/package-digest.ts";

export interface McpCatalogReleaseLock {
  catalogItemId: string;
  version: string;
  toolFingerprint: string;
}

export function computeMcpToolFingerprint(declaredToolsJson: string): string | undefined {
  try {
    const declaredTools = JSON.parse(declaredToolsJson) as unknown;
    return createHash("sha256").update(stableStringify(declaredTools)).digest("hex");
  } catch {
    return undefined;
  }
}

export function resolveLegacyMcpReleasePins(
  fingerprints: Record<string, string> | undefined,
  workspaceId: string,
): Record<string, McpCatalogReleaseLock> | null {
  const resolved: Record<string, McpCatalogReleaseLock> = {};
  for (const [slug, expectedFingerprint] of Object.entries(fingerprints ?? {})) {
    const matches = listMcpCatalogItemReleasesSync(slug, workspaceId).filter(
      (candidate) => computeMcpToolFingerprint(candidate.declaredToolsJson) === expectedFingerprint,
    );
    if (matches.length !== 1) return null;
    const release = matches[0]!;
    resolved[slug] = {
      catalogItemId: release.id,
      version: release.version,
      toolFingerprint: expectedFingerprint,
    };
  }
  return resolved;
}

export function isMcpCatalogReleaseLockMap(value: unknown): value is Record<string, McpCatalogReleaseLock> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const lock = entry as Partial<McpCatalogReleaseLock>;
    return typeof lock.catalogItemId === "string"
      && typeof lock.version === "string"
      && typeof lock.toolFingerprint === "string";
  });
}
