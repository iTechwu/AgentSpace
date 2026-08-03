import { createHash } from "node:crypto";
import {
  createSkillInstallApprovalSync,
  readSkillArtifactByDigestSync,
  readSkillArtifactFilesSync,
  type SkillInstallApprovalRiskItem,
} from "@dofe-agent/db";
import { stableStringify } from "./package/package-digest.ts";

export const SKILL_INSTALL_POLICY_VERSION = "v1";

/**
 * First-install risk classification (P0-2, docs/0803 gap review).
 *
 * Every declarable high-risk capability in an artifact's manifest yields an
 * explicit risk item the admin must authorize ONE BY ONE before an installation
 * plan can be created:
 *   - `script`   → executable script entrypoints / 0755 files
 *   - `network`  → dependency installs, MCP server connections, managed services
 *   - `mcp_tool` → high-risk MCP tools (exec/shell/network patterns)
 *   - `write`    → write-capable MCP tools (create/update/delete/…)
 *
 * The classifier is deterministic and derived ONLY from the immutable artifact,
 * so the risk set seen at inspection time always matches the set re-derived at
 * plan creation — the approval binding stays valid across the two calls.
 */
export function buildSkillInstallRiskItemsSync(input: {
  workspaceId?: string;
  artifactDigest: string;
}): SkillInstallApprovalRiskItem[] {
  const artifact = readSkillArtifactByDigestSync(input.artifactDigest, input.workspaceId);
  if (!artifact) {
    throw new Error(`Skill artifact "${input.artifactDigest}" does not exist in this workspace.`);
  }
  let manifest: {
    dependencies?: Array<{ manager?: string; kind?: string; name?: string; version?: string }>;
    capabilities?: Array<{ kind?: string; catalogSlug?: string; requiredTools?: string[] }>;
    services?: Array<{ catalogSlug?: string; templateVersion?: string }>;
    entrypoints?: Array<{ path?: string; runtime?: string }>;
  };
  try {
    manifest = JSON.parse(artifact.manifestJson) as typeof manifest;
  } catch {
    throw new Error(`Skill artifact "${input.artifactDigest}" has an invalid manifest.`);
  }

  const executablePaths = new Set(
    readSkillArtifactFilesSync(artifact.id)
      .filter((file) => isExecutableMode(file.mode))
      .map((file) => file.path),
  );
  const declaredEntrypointPaths = new Set(
    (manifest.entrypoints ?? []).map((entrypoint) => entrypoint.path).filter((path): path is string => Boolean(path)),
  );

  const items: SkillInstallApprovalRiskItem[] = [];
  const seenScriptKeys = new Set<string>();

  // A script file (declared entrypoint OR plain 0755 executable) is always a
  // `script:<path>` risk item. The key does not depend on whether the path is
  // declared as an entrypoint, so re-declaring an entrypoint does not create a
  // spurious "new risk item" on upgrade.
  for (const entrypoint of manifest.entrypoints ?? []) {
    if (entrypoint.path && !seenScriptKeys.has(entrypoint.path)) {
      seenScriptKeys.add(entrypoint.path);
      items.push({
        category: "script",
        key: `script:${entrypoint.path}`,
        description: `可执行脚本入口 ${entrypoint.path}${entrypoint.runtime ? `（${entrypoint.runtime}）` : ""}`,
      });
    }
  }
  for (const path of executablePaths) {
    if (!declaredEntrypointPaths.has(path) && !seenScriptKeys.has(path)) {
      seenScriptKeys.add(path);
      items.push({
        category: "script",
        key: `script:${path}`,
        description: `可执行文件 ${path}`,
      });
    }
  }

  for (const dependency of manifest.dependencies ?? []) {
    const manager = dependency.manager ?? dependency.kind ?? "package";
    const key = `${manager}:${dependency.name}@${dependency.version}`;
    items.push({
      category: "network",
      key: `dependency:${key}`,
      description: `运行时安装依赖 ${key} 会访问软件源`,
    });
  }

  for (const capability of manifest.capabilities ?? []) {
    if (capability.kind === "mcp" && capability.catalogSlug) {
      items.push({
        category: "network",
        key: `mcp:${capability.catalogSlug}`,
        description: `连接 MCP 服务器 ${capability.catalogSlug}`,
      });
    }
    for (const tool of capability.requiredTools ?? []) {
      const level = classifyMcpToolRisk(tool);
      if (level === "write") {
        items.push({
          category: "write",
          key: `mcp_tool:${capability.catalogSlug ?? "?"}:${tool}`,
          description: `MCP 写能力工具 ${capability.catalogSlug ?? "?"}:${tool}`,
        });
      } else if (level === "exec") {
        items.push({
          category: "mcp_tool",
          key: `mcp_tool:${capability.catalogSlug ?? "?"}:${tool}`,
          description: `高风险 MCP 工具 ${capability.catalogSlug ?? "?"}:${tool}`,
        });
      }
    }
  }

  for (const service of manifest.services ?? []) {
    if (service.catalogSlug) {
      items.push({
        category: "network",
        key: `service:${service.catalogSlug}`,
        description: `部署受管服务 ${service.catalogSlug}@${service.templateVersion ?? "1"}`,
      });
    }
  }

  return items;
}

/** sha256 of the canonical risk decision — the immutable fingerprint an approval binds to. */
export function computeSkillInstallRiskDecisionDigestSync(input: {
  artifactDigest: string;
  releaseLockDigest: string;
  riskItems: SkillInstallApprovalRiskItem[];
}): string {
  return createHash("sha256")
    .update(
      stableStringify({
        artifactDigest: input.artifactDigest,
        releaseLockDigest: input.releaseLockDigest,
        riskItems: input.riskItems,
      }),
    )
    .digest("hex");
}

/**
 * Records an immutable first-install approval bound to
 * `(artifactDigest, releaseLockDigest, policyVersion, riskDecisionDigest)`.
 * The plan gate re-derives the digest and requires a matching unconsumed record
 * before a risk-bearing install proceeds.
 */
export function approveSkillInstallSync(input: {
  workspaceId?: string;
  skillId?: string;
  artifactDigest: string;
  releaseLockDigest: string;
  riskItems: SkillInstallApprovalRiskItem[];
  decision?: "approved" | "rejected";
  reason?: string;
  actorUserId?: string;
}): { approvalId: string; created: boolean } {
  const riskDecisionDigest = computeSkillInstallRiskDecisionDigestSync({
    artifactDigest: input.artifactDigest,
    releaseLockDigest: input.releaseLockDigest,
    riskItems: input.riskItems,
  });
  const approval = createSkillInstallApprovalSync({
    workspaceId: input.workspaceId,
    skillId: input.skillId,
    artifactDigest: input.artifactDigest,
    releaseLockDigest: input.releaseLockDigest,
    policyVersion: SKILL_INSTALL_POLICY_VERSION,
    riskDecisionDigest,
    decision: input.decision ?? "approved",
    riskItems: input.riskItems,
    reason: input.reason,
    actorUserId: input.actorUserId,
  });
  return { approvalId: approval.id, created: !approval.consumedAt };
}

function classifyMcpToolRisk(tool: string): "write" | "exec" | "none" {
  const normalized = tool.toLocaleLowerCase("en-US");
  if (
    /(write|create|update|delete|patch|put|upload|append|edit|modify|insert|remove|move|copy|save|rename|mkdir|rm|unlink|destroy)/.test(normalized)
  ) {
    return "write";
  }
  if (
    /(exec|shell|run|bash|terminal|command|http|fetch|curl|request|browse|search|network|socket|ssh|dns|install|execute)/.test(normalized)
  ) {
    return "exec";
  }
  return "none";
}

function isExecutableMode(mode: string): boolean {
  const trimmed = mode.trim();
  return trimmed === "0755" || trimmed === "755" || trimmed === "0o755" || trimmed === "rwxr-xr-x";
}
