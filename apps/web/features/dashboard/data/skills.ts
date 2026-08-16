// dashboard 技能页数据装配（从 features/dashboard/data.ts 拆出，3.4/3.6 巨型文件项）。

import type { ContainerRecord, RuntimeMcpConnectionView, SkillsPageData } from "../data-types";
import { DEFAULT_WORKSPACE_ID, listDaemonSnapshotsSync, listEmployeeRuntimeBindingsSync, listMcpCatalogItemsSync, listMcpConnectionsSync, listQueuedTasksSync, listRuntimeAppOperationsSync, listRuntimeInstalledAppsSync } from "@dofe-agent/db";
import type { WorkspaceRole } from "@dofe-agent/db";
import type { DofeAgentState } from "@dofe-agent/domain/workspace";
import { buildLegacyAgentIdForEmployeeName, isSystemSkillName, listEmployeeSkillIdsByAgentIdMap, listEmployeeSkillIdsByAgentIdMapSync } from "@dofe-agent/services";
import { buildNativeRuntimeRecord } from "./agent-record.ts";
import { listStoredSkillImportEventsCached, listWorkspaceSkillsCached, readWorkspaceStateCached } from "./cached.ts";
import { resolveAssignedSkillIdsForEmployee } from "./inbox-items.ts";

export function getSkillsPageData(workspaceId = DEFAULT_WORKSPACE_ID, currentMembershipRole?: WorkspaceRole): SkillsPageData {
  return buildSkillsPageData(
    workspaceId,
    currentMembershipRole,
    listEmployeeSkillIdsByAgentIdMapSync(workspaceId),
  );
}
export async function getSkillsPageDataAsync(
  workspaceId = DEFAULT_WORKSPACE_ID,
  currentMembershipRole?: WorkspaceRole,
): Promise<SkillsPageData> {
  return buildSkillsPageData(
    workspaceId,
    currentMembershipRole,
    await listEmployeeSkillIdsByAgentIdMap(workspaceId),
  );
}
export function buildSkillsPageData(
  workspaceId: string,
  currentMembershipRole: WorkspaceRole | undefined,
  skillIdsByAgentId: Map<string, string[]>,
): SkillsPageData {
  const state = readWorkspaceStateCached(workspaceId);
  const workspaceSkills = listWorkspaceSkillsCached(workspaceId);
  const assignedSkillCount = Array.from(skillIdsByAgentId.values()).reduce((sum, skillIds) => sum + skillIds.length, 0);
  const recentImports = listStoredSkillImportEventsCached(workspaceId, 12).map((event) => ({
    id: event.id,
    skillId: event.skillId,
    skillName: event.skillName,
    sourceType: event.sourceType,
    sourceUrl: event.sourceUrl,
    importMode: event.importMode,
    importedAt: event.importedAt,
    warnings: readSkillImportWarnings(event.metadataJson),
  }));

  return {
    skills: workspaceSkills.map((skill) => ({
      ...skill,
      isBuiltin: isSystemSkillName(skill.name),
    })),
    totalSkills: workspaceSkills.length,
    assignedSkillCount,
    currentMembershipRole,
    recentImports,
    agents: state.activeEmployees.map((employee) => ({
      id: buildLegacyAgentIdForEmployeeName(employee.name),
      name: employee.remarkName?.trim() || employee.name,
      internalName: employee.name,
      skillIds: resolveAssignedSkillIdsForEmployee(skillIdsByAgentId, employee),
    })),
  };
}
export function readSkillImportWarnings(metadataJson: string): string[] {
  try {
    const parsed = JSON.parse(metadataJson) as { warnings?: unknown };
    return Array.isArray(parsed.warnings)
      ? parsed.warnings.filter((warning): warning is string => typeof warning === "string")
      : [];
  } catch {
    return [];
  }
}
export function buildNativeRuntimeRecords(
  state: DofeAgentState,
  runtimeSnapshots: ReturnType<typeof listDaemonSnapshotsSync>,
  bindings: ReturnType<typeof listEmployeeRuntimeBindingsSync>,
  queuedTasks: ReturnType<typeof listQueuedTasksSync>,
  runtimeDisplayNames: Map<string, string>,
  installedApps: ReturnType<typeof listRuntimeInstalledAppsSync> = [],
  runtimeAppOperations: ReturnType<typeof listRuntimeAppOperationsSync> = [],
  mcpConnections: ReturnType<typeof listMcpConnectionsSync> = [],
  mcpCatalogItems: ReturnType<typeof listMcpCatalogItemsSync> = [],
): ContainerRecord[] {
  const boundEmployeesByRuntime = new Map<string, string[]>();
  for (const binding of bindings) {
    const next = boundEmployeesByRuntime.get(binding.runtimeId) ?? [];
    next.push(binding.employeeName);
    boundEmployeesByRuntime.set(binding.runtimeId, next);
  }

  const workspaceTaskById = new Map(state.tasks.map((task) => [task.id, task]));
  const queuedTasksByRuntime = new Map<string, ReturnType<typeof listQueuedTasksSync>>();
  for (const queuedTask of queuedTasks) {
    const next = queuedTasksByRuntime.get(queuedTask.runtimeId) ?? [];
    next.push(queuedTask);
    queuedTasksByRuntime.set(queuedTask.runtimeId, next);
  }
  const installedAppsByRuntime = new Map<string, ReturnType<typeof listRuntimeInstalledAppsSync>>();
  for (const app of installedApps) {
    const next = installedAppsByRuntime.get(app.runtimeId) ?? [];
    next.push(app);
    installedAppsByRuntime.set(app.runtimeId, next);
  }
  const appOperationsByRuntime = new Map<string, ReturnType<typeof listRuntimeAppOperationsSync>>();
  for (const operation of runtimeAppOperations) {
    const next = appOperationsByRuntime.get(operation.runtimeId) ?? [];
    next.push(operation);
    appOperationsByRuntime.set(operation.runtimeId, next);
  }
  const mcpCatalogById = new Map(mcpCatalogItems.map((item) => [item.id, item]));
  const mcpConnectionsByRuntime = new Map<string, RuntimeMcpConnectionView[]>();
  for (const connection of mcpConnections) {
    const catalog = mcpCatalogById.get(connection.catalogItemId);
    const next = mcpConnectionsByRuntime.get(connection.runtimeId) ?? [];
    next.push({
      id: connection.id,
      catalogItemId: connection.catalogItemId,
      catalogDisplayName: catalog?.displayName ?? connection.id,
      transport: catalog?.transport ?? "streamable_http",
      status: connection.status,
      approvedToolCount: parseStringArray(connection.approvedToolsJson).length,
      lastVerifiedAt: connection.lastVerifiedAt,
      updatedAt: connection.updatedAt,
    });
    mcpConnectionsByRuntime.set(connection.runtimeId, next);
  }

  return runtimeSnapshots.flatMap((snapshot) =>
    snapshot.runtimes.map((runtime) =>
      buildNativeRuntimeRecord(
        snapshot.daemon,
        runtime,
        runtimeDisplayNames.get(runtime.id),
        boundEmployeesByRuntime.get(runtime.id) ?? [],
        queuedTasksByRuntime.get(runtime.id) ?? [],
        installedAppsByRuntime.get(runtime.id) ?? [],
        appOperationsByRuntime.get(runtime.id) ?? [],
        mcpConnectionsByRuntime.get(runtime.id) ?? [],
        workspaceTaskById,
      ),
    ),
  );
}
export function parseStringArray(value: string | undefined): string[] {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
