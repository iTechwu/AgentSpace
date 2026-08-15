import { createHash } from "node:crypto";
import {
  getDatabase,
  listEmployeeRuntimeBindingsSync,
  listSkillInstallationsSync,
  readSkillArtifactByDigestSync,
  readSkillArtifactsByCoordinateSync,
  readWorkflowVersionSync,
} from "@dofe-agent/db";
import type { SkillArtifactRecord } from "@dofe-agent/db";
import type { SkillSkillDependency } from "@dofe-agent/domain";
import { stableStringify } from "./package/package-digest.ts";
import { buildSkillInstallRiskItemsSync } from "./install-approval.ts";

export const SKILL_ROLLOUT_POLICY_VERSION = "v1";

export type SkillRolloutTargetScope =
  | { kind: "workflow"; workflowId: string }
  | { kind: "employees"; employeeIds: string[] }
  | { kind: "runtimes"; runtimeIds: string[] }
  | { kind: "all-compatible" };

export interface SkillRolloutClosureEntry {
  coordinate: string;
  artifactDigest: string;
  requestedVersion: string;
  placement: "same_runtime" | "workflow";
  required: boolean;
}

export interface SkillRolloutItem {
  runtimeId: string;
  artifactDigest: string;
  revision: string;
  state: "ready" | "installing" | "pending";
}

export interface SkillRolloutRiskSummary {
  totalRiskItems: number;
  artifactsWithRisk: string[];
  riskItems: Array<{ category: string; key: string }>;
}

export interface SkillRolloutPlan {
  planDigest: string;
  root: { artifactDigest: string; coordinate?: string };
  closure: SkillRolloutClosureEntry[];
  items: SkillRolloutItem[];
  risks: SkillRolloutRiskSummary;
  requiredCount: number;
  readyCount: number;
  pendingCount: number;
}

/* ------------------------------------------------------------------ */
/* Version matching (minimal SemVer: exact, ^, ~, *)                   */
/* ------------------------------------------------------------------ */

export function parseSemver(value: string | undefined): number[] | null {
  if (!value) return null;
  const parts = value.trim().split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return parts;
}

function compareParts(left: number[] | null, right: number[] | null): number {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return 0;
}

export function versionSatisfies(version: string, range: string): boolean {
  const normalized = range.trim();
  if (normalized === "" || normalized === "*" || normalized === "latest") return true;
  if (normalized.startsWith("^")) {
    const base = parseSemver(normalized.slice(1));
    const actual = parseSemver(version);
    if (!base || !actual) return false;
    return actual[0] === base[0] && compareParts(actual, base) >= 0;
  }
  if (normalized.startsWith("~")) {
    const base = parseSemver(normalized.slice(1));
    const actual = parseSemver(version);
    if (!base || !actual) return false;
    return actual[0] === base[0] && actual[1] === base[1] && compareParts(actual, base) >= 0;
  }
  const base = parseSemver(normalized);
  if (!base) return version.trim() === normalized;
  const actual = parseSemver(version);
  return actual !== null && compareParts(actual, base) === 0;
}

/* ------------------------------------------------------------------ */
/* Dependency closure                                                  */
/* ------------------------------------------------------------------ */

/** Resolves a coordinate + version range to an exact, already-imported artifact digest. */
export function lockSkillDependencyDigestSync(
  coordinate: string,
  versionRange: string,
  workspaceId = "default",
): { artifactDigest: string; version: string } {
  const artifacts = readSkillArtifactsByCoordinateSync(coordinate, workspaceId);
  const satisfying = artifacts
    .filter((artifact) => versionSatisfies(artifact.version || "0.0.0", versionRange))
    .sort((left, right) => compareParts(parseSemver(right.version), parseSemver(left.version)));
  const best = satisfying[0];
  if (!best) {
    throw new Error(
      `skill_dependency_unresolved: no artifact for "${coordinate}" satisfies "${versionRange}".`,
    );
  }
  return { artifactDigest: best.digest, version: best.version };
}

export function resolveSkillDependencyClosureSync(input: {
  workspaceId?: string;
  rootArtifactDigest: string;
  dependencyMode?: "required-only" | "include-optional";
}): SkillRolloutClosureEntry[] {
  const workspaceId = input.workspaceId ?? "default";
  const mode = input.dependencyMode ?? "required-only";
  const entries: SkillRolloutClosureEntry[] = [];
  const emitted = new Set<string>([input.rootArtifactDigest]);
  const processed = new Set<string>();
  const visiting: string[] = [];

  const visit = (artifactDigest: string): void => {
    const cycleIndex = visiting.indexOf(artifactDigest);
    if (cycleIndex >= 0) {
      const cycle = [...visiting.slice(cycleIndex), artifactDigest].join(" -> ");
      throw new Error(`skill_dependency_cycle: ${cycle}`);
    }
    if (processed.has(artifactDigest)) return;
    const artifact = readSkillArtifactByDigestSync(artifactDigest, workspaceId);
    if (!artifact) {
      throw new Error(`Skill artifact "${artifactDigest}" does not exist in this workspace.`);
    }
    const dependencies = parseSkillDependencies(artifact.manifestJson);
    visiting.push(artifactDigest);
    for (const dependency of dependencies) {
      if (dependency.required === false && mode === "required-only") continue;
      const locked = lockSkillDependencyDigestSync(dependency.coordinate, dependency.version, workspaceId);
      if (!emitted.has(locked.artifactDigest)) {
        entries.push({
          coordinate: dependency.coordinate,
          artifactDigest: locked.artifactDigest,
          requestedVersion: dependency.version,
          placement: dependency.placement,
          required: dependency.required,
        });
        emitted.add(locked.artifactDigest);
      }
      visit(locked.artifactDigest);
    }
    visiting.pop();
    processed.add(artifactDigest);
  };

  visit(input.rootArtifactDigest);
  return entries;
}

function parseSkillDependencies(manifestJson: string): SkillSkillDependency[] {
  try {
    const parsed = JSON.parse(manifestJson) as { skillDependencies?: SkillSkillDependency[] };
    return Array.isArray(parsed.skillDependencies) ? parsed.skillDependencies : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Target runtime mapping                                              */
/* ------------------------------------------------------------------ */

export function computeSkillRolloutTargetRuntimesSync(
  scope: SkillRolloutTargetScope,
  workspaceId = "default",
): string[] {
  if (scope.kind === "runtimes") {
    return [...new Set(scope.runtimeIds)];
  }
  if (scope.kind === "employees") {
    const wanted = new Set(scope.employeeIds);
    return [...new Set(
      listEmployeeRuntimeBindingsSync(workspaceId)
        .filter((binding) => wanted.has(binding.employeeId))
        .map((binding) => binding.runtimeId),
    )];
  }
  if (scope.kind === "workflow") {
    const version = readWorkflowVersionSync(scope.workflowId, workspaceId);
    if (!version) {
      throw new Error(`Workflow "${scope.workflowId}" does not exist in this workspace.`);
    }
    let employeeIds: string[] = [];
    try {
      const graph = JSON.parse(version.graphJson) as { nodes?: Array<{ type?: string; employeeId?: string }> };
      employeeIds = (graph.nodes ?? [])
        .filter((node) => node.type === "employee_task" && typeof node.employeeId === "string")
        .map((node) => node.employeeId!);
    } catch {
      employeeIds = [];
    }
    return computeSkillRolloutTargetRuntimesSync({ kind: "employees", employeeIds }, workspaceId);
  }
  const rows = getDatabase().prepare(
    `SELECT id FROM agent_runtime WHERE workspace_id = ? ORDER BY id ASC`,
  ).all(workspaceId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/* ------------------------------------------------------------------ */
/* Items, risks, plan digest                                           */
/* ------------------------------------------------------------------ */

export function buildSkillRolloutItemsSync(input: {
  workspaceId?: string;
  rootArtifactDigest: string;
  closure: SkillRolloutClosureEntry[];
  runtimeIds: string[];
}): SkillRolloutItem[] {
  const workspaceId = input.workspaceId ?? "default";
  const digests = [input.rootArtifactDigest, ...input.closure.map((entry) => entry.artifactDigest)];
  const items: SkillRolloutItem[] = [];
  for (const runtimeId of input.runtimeIds) {
    for (const artifactDigest of digests) {
      items.push(resolveRolloutItemState({ workspaceId, runtimeId, artifactDigest }));
    }
  }
  return items;
}

function resolveRolloutItemState(input: {
  workspaceId: string;
  runtimeId: string;
  artifactDigest: string;
}): SkillRolloutItem {
  const installations = listSkillInstallationsSync({
    workspaceId: input.workspaceId,
    runtimeId: input.runtimeId,
    artifactDigest: input.artifactDigest,
  });
  const ready = installations.find((installation) => installation.status === "ready");
  if (ready) {
    return { runtimeId: input.runtimeId, artifactDigest: input.artifactDigest, revision: ready.revision, state: "ready" };
  }
  const preparing = installations.find((installation) => installation.status === "preparing");
  if (preparing) {
    return { runtimeId: input.runtimeId, artifactDigest: input.artifactDigest, revision: preparing.revision, state: "installing" };
  }
  return { runtimeId: input.runtimeId, artifactDigest: input.artifactDigest, revision: "v1", state: "pending" };
}

export function aggregateSkillRolloutRiskSync(input: {
  workspaceId?: string;
  rootArtifactDigest: string;
  closure: SkillRolloutClosureEntry[];
}): SkillRolloutRiskSummary {
  const workspaceId = input.workspaceId ?? "default";
  const digests = [input.rootArtifactDigest, ...input.closure.map((entry) => entry.artifactDigest)];
  const riskItems = new Map<string, { category: string; key: string }>();
  const artifactsWithRisk: string[] = [];
  for (const digest of digests) {
    const items = buildSkillInstallRiskItemsSync({ workspaceId, artifactDigest: digest });
    if (items.length > 0) artifactsWithRisk.push(digest);
    for (const item of items) {
      riskItems.set(`${item.category}:${item.key}`, { category: item.category, key: item.key });
    }
  }
  const sorted = [...riskItems.values()].sort((left, right) =>
    `${left.category}:${left.key}`.localeCompare(`${right.category}:${right.key}`));
  return {
    totalRiskItems: sorted.length,
    artifactsWithRisk: [...artifactsWithRisk].sort(),
    riskItems: sorted,
  };
}

export function computeSkillRolloutPlanDigestSync(input: {
  rootArtifactDigest: string;
  closure: SkillRolloutClosureEntry[];
  targetRuntimes: string[];
  risks: SkillRolloutRiskSummary;
  policyVersion?: string;
}): string {
  const canonical = {
    root: input.rootArtifactDigest,
    closure: [...input.closure]
      .map((entry) => ({
        coordinate: entry.coordinate,
        artifactDigest: entry.artifactDigest,
        requestedVersion: entry.requestedVersion,
        placement: entry.placement,
        required: entry.required,
      }))
      .sort((left, right) => left.coordinate.localeCompare(right.coordinate)),
    targetRuntimes: [...input.targetRuntimes].sort(),
    policyVersion: input.policyVersion ?? SKILL_ROLLOUT_POLICY_VERSION,
    riskItems: input.risks.riskItems
      .map((item) => ({ category: item.category, key: item.key }))
      .sort((left, right) => `${left.category}:${left.key}`.localeCompare(`${right.category}:${right.key}`)),
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function planSkillRollout(input: {
  workspaceId?: string;
  rootArtifactDigest: string;
  targetScope: SkillRolloutTargetScope;
  dependencyMode?: "required-only" | "include-optional";
}): SkillRolloutPlan {
  const workspaceId = input.workspaceId ?? "default";
  const root = readSkillArtifactByDigestSync(input.rootArtifactDigest, workspaceId);
  if (!root) {
    throw new Error(`Skill artifact "${input.rootArtifactDigest}" does not exist in this workspace.`);
  }
  const closure = resolveSkillDependencyClosureSync({
    workspaceId,
    rootArtifactDigest: input.rootArtifactDigest,
    dependencyMode: input.dependencyMode,
  });
  const targetRuntimes = computeSkillRolloutTargetRuntimesSync(input.targetScope, workspaceId);
  const items = buildSkillRolloutItemsSync({
    workspaceId,
    rootArtifactDigest: input.rootArtifactDigest,
    closure,
    runtimeIds: targetRuntimes,
  });
  const risks = aggregateSkillRolloutRiskSync({ workspaceId, rootArtifactDigest: input.rootArtifactDigest, closure });
  const planDigest = computeSkillRolloutPlanDigestSync({
    rootArtifactDigest: input.rootArtifactDigest,
    closure,
    targetRuntimes,
    risks,
  });
  const readyCount = items.filter((item) => item.state === "ready").length;
  const pendingCount = items.filter((item) => item.state !== "ready").length;
  const requiredCount = 1 + closure.filter((entry) => entry.required).length;
  return {
    planDigest,
    root: { artifactDigest: input.rootArtifactDigest, coordinate: root.coordinate },
    closure,
    items,
    risks,
    requiredCount,
    readyCount,
    pendingCount,
  };
}
