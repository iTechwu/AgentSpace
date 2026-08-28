import type {
  WorkspaceModuleCacheEntry,
} from "@/features/dashboard/workspace-module-cache";
import type { WorkspaceModuleId } from "@/features/dashboard/workspace-module-route";

export type WorkspaceInvalidationResourceType =
  | "channel"
  | "document"
  | "task"
  | "agent"
  | "approval"
  | "settings";

export interface WorkspaceInvalidationEvent {
  workspaceId: string;
  modules?: WorkspaceModuleId[];
  resources?: Array<{
    type: WorkspaceInvalidationResourceType;
    id?: string;
  }>;
  shell?: "stable" | "counters" | "all";
  permissionVersion?: string | number;
}

const RESOURCE_MODULES: Record<WorkspaceInvalidationResourceType, readonly WorkspaceModuleId[]> = {
  agent: ["agents", "inbox", "im", "market", "skills", "knowledge"],
  approval: ["approvals", "inbox"],
  channel: ["im", "contacts", "inbox", "agents", "automations"],
  document: ["knowledge", "im", "inbox", "agents"],
  settings: ["settings"],
  task: ["task-board", "inbox", "agents"],
};

export function matchesWorkspaceInvalidation(
  entry: WorkspaceModuleCacheEntry,
  event: WorkspaceInvalidationEvent,
): boolean {
  if (entry.metadata.workspaceId !== event.workspaceId) {
    return false;
  }

  if (
    event.permissionVersion !== undefined &&
    entry.metadata.permissionVersion !== event.permissionVersion
  ) {
    return false;
  }

  if (event.modules?.includes(entry.metadata.moduleId)) {
    return true;
  }

  return event.resources?.some((resource) => matchesInvalidationResource(entry, resource)) ?? false;
}

function matchesInvalidationResource(
  entry: WorkspaceModuleCacheEntry,
  resource: NonNullable<WorkspaceInvalidationEvent["resources"]>[number],
): boolean {
  if (!RESOURCE_MODULES[resource.type].includes(entry.metadata.moduleId)) {
    return false;
  }

  if (!resource.id) {
    return true;
  }

  if (entry.metadata.resourceRefs?.[resource.type]?.includes(resource.id)) {
    return true;
  }

  if (entry.metadata.resourceKey) {
    return entry.metadata.resourceKey.includes(resource.id);
  }

  return false;
}
