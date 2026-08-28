// 权限中心共享纯工具：JSON 读取、键归一、分组、主体排序等。
import {
  listAgentAccessRequestsSync,
} from "@dofe-agent/db";
import type {
  ChannelDocument,
} from "@dofe-agent/domain/workspace";
import {
  sameValue,
} from "../shared/helpers.ts";
import type {
  PermissionActorSummary,
  PermissionBinding,
  PermissionBuildContext,
  PermissionCatalogMember,
  PermissionSubjectType,
} from "./permission-types.ts";

export function resolveAgentLabel(context: PermissionBuildContext, agentId: string): string {
  const employee = context.visibleEmployees.find((item) => sameValue(item.name, agentId));
  return employee?.remarkName ?? employee?.name ?? agentId;
}

export function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return readRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

export function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function metadataString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

export function readAllowedString<T extends string>(
  value: unknown,
  allowedValues: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && allowedValues.includes(value as T) ? value as T : fallback;
}

export function readStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const normalized = value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean);
  return normalized.length > 0 ? normalized : fallback;
}

export function buildWorkspaceManagerInheritedBindings(
  context: PermissionBuildContext,
  permission: string,
): PermissionBinding[] {
  return Array.from(context.memberByUserId.values())
    .filter((member) => member.role === "owner" || member.role === "admin")
    .map((member) => ({
      subjectType: "human",
      subjectId: member.userId,
      subjectLabel: memberLabel(member),
      permission,
      source: "workspace_role",
      status: "inherited",
      editable: false,
      inheritedFromNodeId: context.workspaceNodeId,
      metadata: {
        userId: member.userId,
        role: member.role,
      },
    }));
}

export function groupByKey<T>(items: T[], keyForItem: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyForItem(item);
    const values = map.get(key) ?? [];
    values.push(item);
    map.set(key, values);
  }
  return map;
}

export function groupByNormalizedKey<T>(items: T[], keyForItem: (item: T) => string): Map<string, T[]> {
  return groupByKey(items, (item) => normalizeKey(keyForItem(item)));
}

export function dedupeActorPermissions(
  permissions: PermissionActorSummary["permissions"],
): PermissionActorSummary["permissions"] {
  const seen = new Set<string>();
  const result: PermissionActorSummary["permissions"] = [];
  for (const permission of permissions) {
    const key = [
      permission.nodeId,
      permission.permission,
      permission.source,
      permission.status,
    ].join(":");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(permission);
  }
  return result;
}

export function subjectTypeRank(type: PermissionSubjectType): number {
  switch (type) {
    case "human":
      return 0;
    case "agent":
      return 1;
    case "daemon_token":
      return 2;
    case "external_guest":
      return 3;
    case "system":
      return 4;
  }
}

export function externalDocumentNodeId(document: ChannelDocument): string {
  return `external-document:${document.id}`;
}

export function actorKey(subjectType: PermissionSubjectType, subjectId: string): string {
  return `${subjectType}:${subjectId}`;
}

export function parseAgentForkOrigin(origin: string | undefined): { sourceAgentName: string; invitationId: string } | undefined {
  if (!origin) {
    return undefined;
  }
  const match = /^agent-fork:(.*):([^:]+)$/.exec(origin);
  if (!match) {
    return undefined;
  }
  return {
    sourceAgentName: match[1] ?? "",
    invitationId: match[2] ?? "",
  };
}

export function describeAgentAccessRequestPermission(
  request: ReturnType<typeof listAgentAccessRequestsSync>[number],
  sourceLabel?: string,
): string {
  if (request.requestType === "channel_use") {
    const target = request.targetChannelName ? ` in #${request.targetChannelName}` : "";
    return sourceLabel ? `requested channel use of ${sourceLabel}${target}` : `requested channel use${target}`;
  }
  return sourceLabel ? `requested copy of ${sourceLabel}` : "requested agent copy";
}

export function normalizeKey(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

export function memberLabel(member: Pick<PermissionCatalogMember, "displayName" | "primaryEmail">): string {
  return member.primaryEmail ? `${member.displayName} <${member.primaryEmail}>` : member.displayName;
}
