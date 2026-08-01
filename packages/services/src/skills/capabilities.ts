import { getDatabase } from "@dofe-agent/db";
import { listReadyMcpConnectionsForTaskSync } from "../mcp-center/connections.ts";
import { readSkillArtifactByDigestSync } from "@dofe-agent/db";
import { readSkillInstallationComponentsSync } from "@dofe-agent/db";
import { updateSkillInstallationComponentStatusSync } from "@dofe-agent/db";
import { sameValue } from "../shared/helpers.ts";

/**
 * Skill → capability resolution (Phase 3).
 *
 * A skill's `capabilities` only DECLARE what the skill needs; they resolve to
 * ready, platform-managed capabilities on the SAME runtime:
 *   - `mcp:<catalogSlug>`   → a ready MCP connection whose approved∩discovered
 *     tools cover the declared requiredTools (MCP Center is authoritative).
 *   - `cli:<catalogSlug>`    → an installed + enabled runtime app.
 *
 * A capability component is `ready` ONLY when the underlying platform
 * capability is ready. Nothing is satisfied by a config string or an env var.
 */

export interface SkillCapabilityResolution {
  ready: boolean;
  /** Resolved MCP connection id (when a matching ready connection exists). */
  connectionId?: string;
  matchedTools: string[];
  missingTools: string[];
  reason: string;
}

export function resolveSkillMcpCapabilitySync(input: {
  workspaceId: string;
  runtimeId: string;
  catalogSlug: string;
  requiredTools?: string[];
}): SkillCapabilityResolution {
  const readyConnections = listReadyMcpConnectionsForTaskSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
  });
  const candidates = readyConnections.filter((connection) =>
    sameValue(connection.catalogItemSlug, input.catalogSlug),
  );
  if (candidates.length === 0) {
    return {
      ready: false,
      matchedTools: [],
      missingTools: input.requiredTools ?? [],
      reason: `No ready MCP connection matches catalog slug "${input.catalogSlug}" on this runtime.`,
    };
  }

  // Prefer the ready connection exposing the most tools.
  const candidate = [...candidates].sort((left, right) => right.tools.length - left.tools.length)[0]!;
  const available = new Set(candidate.tools.map((tool) => tool.name));
  const requiredTools = input.requiredTools ?? [];
  const missingTools = requiredTools.filter((tool) => !available.has(tool));
  const matchedTools = requiredTools.filter((tool) => available.has(tool));

  if (missingTools.length > 0) {
    return {
      ready: false,
      matchedTools,
      missingTools,
      reason: `Ready MCP connection "${candidate.connectionId}" (${input.catalogSlug}) is missing required tools: ${missingTools.join(", ")}.`,
    };
  }
  return {
    ready: true,
    connectionId: candidate.connectionId,
    matchedTools: candidate.tools.map((tool) => tool.name),
    missingTools: [],
    reason: "",
  };
}

export function resolveSkillCliCapabilitySync(input: {
  workspaceId: string;
  runtimeId: string;
  catalogSlug: string;
}): { ready: boolean; appId?: string; reason: string } {
  const row = getDatabase().prepare(
    `SELECT id, enabled, status FROM runtime_installed_app
     WHERE workspace_id = ? AND runtime_id = ? AND name = ? LIMIT 1`,
  ).get(input.workspaceId, input.runtimeId, input.catalogSlug) as
    | { id: string; enabled: number; status: string }
    | undefined;
  if (!row) {
    return { ready: false, reason: `No installed app matches catalog slug "${input.catalogSlug}" on this runtime.` };
  }
  if (row.enabled !== 1) {
    return { ready: false, appId: row.id, reason: `App "${input.catalogSlug}" is installed but disabled.` };
  }
  if (row.status !== "installed" && row.status !== "ready") {
    return { ready: false, appId: row.id, reason: `App "${input.catalogSlug}" is not ready (status "${row.status}").` };
  }
  return { ready: true, appId: row.id, reason: "" };
}

/**
 * Re-resolves every mcp/cli component of an installation against ready
 * platform capabilities and updates its status. Called by the readiness gate
 * so `ready` can never be reached while a declared capability is unresolved.
 */
export function evaluateSkillInstallationCapabilitiesSync(input: {
  installationId: string;
  workspaceId: string;
  runtimeId: string;
  artifactDigest: string;
}): void {
  const components = readSkillInstallationComponentsSync(input.installationId);
  const artifact = readSkillArtifactByDigestSync(input.artifactDigest, input.workspaceId);
  let manifestCapabilities: Array<{ kind?: string; catalogSlug?: string; requiredTools?: string[] }> = [];
  if (artifact) {
    try {
      const parsed = JSON.parse(artifact.manifestJson) as { capabilities?: typeof manifestCapabilities };
      manifestCapabilities = parsed.capabilities ?? [];
    } catch {
      manifestCapabilities = [];
    }
  }

  for (const component of components) {
    if (component.kind === "mcp") {
      const slug = component.key.replace(/^mcp:/, "");
      const declaration = manifestCapabilities.find(
        (capability) => capability.kind === "mcp" && sameValue(capability.catalogSlug ?? "", slug),
      );
      const resolution = resolveSkillMcpCapabilitySync({
        workspaceId: input.workspaceId,
        runtimeId: input.runtimeId,
        catalogSlug: slug,
        requiredTools: declaration?.requiredTools,
      });
      updateSkillInstallationComponentStatusSync({
        installationId: input.installationId,
        kind: "mcp",
        key: component.key,
        status: resolution.ready ? "ready" : "blocked",
        errorCode: resolution.ready ? undefined : "capability.unresolved",
        errorMessage: resolution.ready ? undefined : resolution.reason,
        verifiedAt: resolution.ready ? new Date().toISOString() : undefined,
      });
    } else if (component.kind === "cli") {
      const slug = component.key.replace(/^cli:/, "");
      const resolution = resolveSkillCliCapabilitySync({
        workspaceId: input.workspaceId,
        runtimeId: input.runtimeId,
        catalogSlug: slug,
      });
      updateSkillInstallationComponentStatusSync({
        installationId: input.installationId,
        kind: "cli",
        key: component.key,
        status: resolution.ready ? "ready" : "blocked",
        errorCode: resolution.ready ? undefined : "capability.unresolved",
        errorMessage: resolution.ready ? undefined : resolution.reason,
        verifiedAt: resolution.ready ? new Date().toISOString() : undefined,
      });
    }
  }
}
