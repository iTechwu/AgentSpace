import { createHash } from "node:crypto";
import {
  consumeSkillRolloutPlanSync,
  getDatabase,
  listEmployeeRuntimeBindingsSync,
  listSkillInstallationsSync,
  readSkillArtifactByDigestSync,
  readSkillArtifactsByCoordinateSync,
  readWorkflowVersionSync,
} from "@dofe-agent/db";
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
  /** The artifact digest of the skill that declared this dependency (co-location anchor). */
  parentArtifactDigest?: string;
}

export interface SkillRolloutSkippedDependency {
  coordinate: string;
  requestedVersion: string;
  placement: "same_runtime" | "workflow";
  reason: "optional";
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
  skipped: SkillRolloutSkippedDependency[];
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

export function resolveSkillDependencyClosureDetailedSync(input: {
  workspaceId?: string;
  rootArtifactDigest: string;
  dependencyMode?: "required-only" | "include-optional";
}): { entries: SkillRolloutClosureEntry[]; skipped: SkillRolloutSkippedDependency[] } {
  const workspaceId = input.workspaceId ?? "default";
  const mode = input.dependencyMode ?? "required-only";
  const entries: SkillRolloutClosureEntry[] = [];
  const skipped: SkillRolloutSkippedDependency[] = [];
  const emitted = new Set<string>([input.rootArtifactDigest]);
  const processed = new Set<string>();
  const visiting: string[] = [];
  const coordinateDecls = new Map<string, { requestedVersion: string; placement: string }>();

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
      // Cross-parent conflict: the same coordinate declared with a different
      // version range or placement is rejected (textual comparison, fail-closed).
      const declKey = dependency.coordinate.toLowerCase();
      const previous = coordinateDecls.get(declKey);
      if (previous && (previous.requestedVersion !== dependency.version || previous.placement !== dependency.placement)) {
        throw new Error(`skill_dependency_conflict: "${dependency.coordinate}" declared with conflicting version/placement.`);
      }
      coordinateDecls.set(declKey, { requestedVersion: dependency.version, placement: dependency.placement });

      if (dependency.required === false && mode === "required-only") {
        skipped.push({
          coordinate: dependency.coordinate,
          requestedVersion: dependency.version,
          placement: dependency.placement,
          reason: "optional",
        });
        continue;
      }
      const locked = lockSkillDependencyDigestSync(dependency.coordinate, dependency.version, workspaceId);
      if (!emitted.has(locked.artifactDigest)) {
        entries.push({
          coordinate: dependency.coordinate,
          artifactDigest: locked.artifactDigest,
          requestedVersion: dependency.version,
          placement: dependency.placement,
          required: dependency.required,
          parentArtifactDigest: artifactDigest,
        });
        emitted.add(locked.artifactDigest);
      }
      visit(locked.artifactDigest);
    }
    visiting.pop();
    processed.add(artifactDigest);
  };

  visit(input.rootArtifactDigest);
  return { entries, skipped };
}

export function resolveSkillDependencyClosureSync(input: {
  workspaceId?: string;
  rootArtifactDigest: string;
  dependencyMode?: "required-only" | "include-optional";
}): SkillRolloutClosureEntry[] {
  return resolveSkillDependencyClosureDetailedSync(input).entries;
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
    `SELECT id FROM agent_runtime WHERE workspace_id = ? AND status = 'online' ORDER BY id ASC`,
  ).all(workspaceId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/**
 * Resolves the ROOT runtime set — where the root skill and its transitive
 * `same_runtime` closure install. For an explicit runtime list / all-compatible
 * scope this is every target runtime; for an employees / workflow scope it is
 * the coordinator runtime only (docs/0815/01 §4: 编排入口只装协调者).
 */
export function resolveSkillRolloutRootRuntimeIdsSync(
  scope: SkillRolloutTargetScope,
  workspaceId = "default",
): string[] {
  if (scope.kind === "runtimes") {
    return [...new Set(scope.runtimeIds)];
  }
  if (scope.kind === "employees") {
    const coordinator = scope.employeeIds[0];
    if (!coordinator) return [];
    const binding = listEmployeeRuntimeBindingsSync(workspaceId).find((candidate) => candidate.employeeId === coordinator);
    return binding ? [binding.runtimeId] : [];
  }
  if (scope.kind === "workflow") {
    const version = readWorkflowVersionSync(scope.workflowId, workspaceId);
    if (!version) return [];
    let coordinatorEmployeeId: string | undefined;
    try {
      const graph = JSON.parse(version.graphJson) as { nodes?: Array<{ type?: string; employeeId?: string }> };
      coordinatorEmployeeId = (graph.nodes ?? [])
        .find((node) => node.type === "employee_task" && typeof node.employeeId === "string")
        ?.employeeId;
    } catch {
      coordinatorEmployeeId = undefined;
    }
    if (!coordinatorEmployeeId) return [];
    return resolveSkillRolloutRootRuntimeIdsSync({ kind: "employees", employeeIds: [coordinatorEmployeeId] }, workspaceId);
  }
  const rows = getDatabase().prepare(
    `SELECT id FROM agent_runtime WHERE workspace_id = ? AND status = 'online' ORDER BY id ASC`,
  ).all(workspaceId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/* ------------------------------------------------------------------ */
/* Items, risks, plan digest                                           */
/* ------------------------------------------------------------------ */

function computePlacementRuntimeIds(input: {
  rootArtifactDigest: string;
  closure: SkillRolloutClosureEntry[];
  rootRuntimeIds: string[];
  primaryRuntimeId: string;
}): Map<string, string[]> {
  const children = new Map<string, Array<{ artifactDigest: string; placement: "same_runtime" | "workflow" }>>();
  for (const entry of input.closure) {
    const parent = entry.parentArtifactDigest ?? input.rootArtifactDigest;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent)!.push({ artifactDigest: entry.artifactDigest, placement: entry.placement });
  }
  const runtimeIds = new Map<string, string[]>();
  runtimeIds.set(input.rootArtifactDigest, input.rootRuntimeIds);
  const queue = [input.rootArtifactDigest];
  const visited = new Set<string>([input.rootArtifactDigest]);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    const parentRuntimes = runtimeIds.get(parent) ?? input.rootRuntimeIds;
    for (const child of children.get(parent) ?? []) {
      const childRuntimes = child.placement === "same_runtime" ? parentRuntimes : [input.primaryRuntimeId];
      runtimeIds.set(child.artifactDigest, childRuntimes);
      if (!visited.has(child.artifactDigest)) {
        visited.add(child.artifactDigest);
        queue.push(child.artifactDigest);
      }
    }
  }
  return runtimeIds;
}

/**
 * Computes the installation items honoring `placement`:
 * - the root + its transitive `same_runtime` closure co-locate on the root runtime set;
 * - each `workflow` dependency installs on the PRIMARY runtime only (one node,
 *   never the full cartesian product).
 */
export function computeSkillRolloutItemsSync(input: {
  workspaceId?: string;
  rootArtifactDigest: string;
  closure: SkillRolloutClosureEntry[];
  rootRuntimeIds: string[];
  primaryRuntimeId?: string;
}): SkillRolloutItem[] {
  const workspaceId = input.workspaceId ?? "default";
  const primary = input.primaryRuntimeId ?? input.rootRuntimeIds[0];
  if (!primary) return [];
  const runtimeIdsByDigest = computePlacementRuntimeIds({
    rootArtifactDigest: input.rootArtifactDigest,
    closure: input.closure,
    rootRuntimeIds: input.rootRuntimeIds,
    primaryRuntimeId: primary,
  });
  const items: SkillRolloutItem[] = [];
  const seen = new Set<string>();
  for (const [artifactDigest, runtimeIds] of runtimeIdsByDigest) {
    for (const runtimeId of runtimeIds) {
      const key = `${runtimeId}:${artifactDigest}`;
      if (seen.has(key)) continue;
      seen.add(key);
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

function collectClosureArtifactDigests(rootArtifactDigest: string, closure: SkillRolloutClosureEntry[]): string[] {
  return [rootArtifactDigest, ...closure.map((entry) => entry.artifactDigest)];
}

export function aggregateSkillRolloutRiskSync(input: {
  workspaceId?: string;
  rootArtifactDigest: string;
  closure: SkillRolloutClosureEntry[];
}): SkillRolloutRiskSummary {
  const workspaceId = input.workspaceId ?? "default";
  const digests = collectClosureArtifactDigests(input.rootArtifactDigest, input.closure);
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

/**
 * Re-derives the planDigest from a plan's STORED fields, for the anti-tamper
 * replay guard: the digest the admin approved must still equal the closure +
 * target runtimes + risk set persisted on the plan. Returns null when the JSON
 * is malformed or not in canonical shape (fail-closed).
 */
export function recomputeSkillRolloutPlanDigestSync(input: {
  rootArtifactDigest: string;
  closureJson: string;
  targetRuntimesJson: string;
  riskSummaryJson: string;
  policyVersion?: string;
}): string | null {
  try {
    const closure = JSON.parse(input.closureJson) as SkillRolloutClosureEntry[];
    const targetRuntimes = JSON.parse(input.targetRuntimesJson) as string[];
    const risks = JSON.parse(input.riskSummaryJson) as SkillRolloutRiskSummary;
    if (!Array.isArray(closure) || !Array.isArray(targetRuntimes) || !risks || !Array.isArray(risks.riskItems)) {
      return null;
    }
    return computeSkillRolloutPlanDigestSync({
      rootArtifactDigest: input.rootArtifactDigest,
      closure,
      targetRuntimes,
      risks,
      policyVersion: input.policyVersion,
    });
  } catch {
    return null;
  }
}

/**
 * Marks an approved rollout plan consumed once all of its child installations
 * have been dispatched. After this, no new child installation may reference the
 * plan (the replay guard rejects consumed plans). Called by the orchestration
 * flow (G1), not per child installation.
 */
export function finalizeSkillRolloutPlanSync(
  planId: string,
  workspaceId = "default",
): boolean {
  return consumeSkillRolloutPlanSync(planId, workspaceId);
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
  const { entries: closure, skipped } = resolveSkillDependencyClosureDetailedSync({
    workspaceId,
    rootArtifactDigest: input.rootArtifactDigest,
    dependencyMode: input.dependencyMode,
  });
  const targetRuntimes = computeSkillRolloutTargetRuntimesSync(input.targetScope, workspaceId);
  const rootRuntimeIds = resolveSkillRolloutRootRuntimeIdsSync(input.targetScope, workspaceId);
  const items = computeSkillRolloutItemsSync({
    workspaceId,
    rootArtifactDigest: input.rootArtifactDigest,
    closure,
    rootRuntimeIds,
    primaryRuntimeId: rootRuntimeIds[0],
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
    skipped,
  };
}
