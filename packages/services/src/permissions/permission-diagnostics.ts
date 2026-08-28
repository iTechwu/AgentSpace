// 权限诊断生成与按节点挂载/可见性过滤。
import {
  listDaemonApiTokensSync,
  listEmployeeRuntimeBindingsSync,
  listRuntimeGrantsSync,
} from "@dofe-agent/db";
import {
  resolveChannelHumanMemberNames,
} from "../shared/channel-members.ts";
import {
  sameValue,
} from "../shared/helpers.ts";
import {
  documentVisibleToActor,
  getChannelParticipants,
} from "./permission-context.ts";
import type {
  PermissionBuildContext,
  PermissionCenterActorInput,
  PermissionDiagnostic,
  PermissionTreeNode,
} from "./permission-types.ts";
import {
  externalDocumentNodeId,
  normalizeKey,
} from "./permission-utils.ts";

export function buildPermissionDiagnostics(
  input: {
    workspaceId: string;
    actor: PermissionCenterActorInput;
  },
  context: PermissionBuildContext,
): PermissionDiagnostic[] {
  const state = context.state;
  const diagnostics: PermissionDiagnostic[] = [];
  const membersByDisplayName = context.memberByDisplayName;
  const runtimeGrantKeys = new Set(
    listRuntimeGrantsSync(input.workspaceId)
      .filter((grant) => grant.status === "active")
      .map((grant) => `${grant.runtimeId}:${grant.userId}`),
  );
  const bindingsByEmployee = new Map(
    listEmployeeRuntimeBindingsSync(input.workspaceId).map((binding) => [binding.employeeName, binding]),
  );

  for (const access of state.channelDocumentAccesses) {
    if (access.actorType !== "human") {
      continue;
    }
    const member = membersByDisplayName.get(normalizeKey(access.actorId));
    if (!member) {
      diagnostics.push({
        id: `diagnostic:document-collaborator-missing-member:${access.id}`,
        severity: "warning",
        title: "Document collaborator is not an active workspace member",
        description: `${access.actorId} still has ${access.role} access on a channel document, but no active workspace membership was found.`,
        source: "document_collaborator",
        resourceNodeId: `document:${access.documentId}`,
        subjectType: "human",
        subjectId: `human:${access.actorId}`,
        lastChangedAt: access.updatedAt,
      });
    }
  }

  for (const employee of state.activeEmployees) {
    const binding = bindingsByEmployee.get(employee.name);
    if (!binding || !employee.ownerUserId) {
      continue;
    }
    const owner = context.memberByUserId.get(employee.ownerUserId);
    const ownerIsManager = owner?.role === "owner" || owner?.role === "admin";
    if (!ownerIsManager && !runtimeGrantKeys.has(`${binding.runtimeId}:${employee.ownerUserId}`)) {
      diagnostics.push({
        id: `diagnostic:agent-owner-runtime-grant:${employee.name}:${binding.runtimeId}`,
        severity: "warning",
        title: "Agent owner lacks a direct runtime grant",
        description: `${employee.remarkName ?? employee.name} is bound to ${context.runtimeLabelById.get(binding.runtimeId) ?? binding.runtimeName}, but its owner does not have a direct use grant for that runtime.`,
        source: "runtime_grant",
        resourceNodeId: `agent:${employee.name}`,
        subjectType: "agent",
        subjectId: employee.name,
        lastChangedAt: binding.updatedAt,
      });
    }
  }

  for (const document of state.channelDocuments) {
    if (document.externalSyncStatus === "permission_error") {
      diagnostics.push({
        id: `diagnostic:external-document-permission-error:${document.id}`,
        severity: "critical",
        title: "External document permission sync failed",
        description: `${document.title} is marked as permission_error. Re-sync permissions through its configured integration.`,
        source: "external_document_permission",
        resourceNodeId: externalDocumentNodeId(document),
        lastChangedAt: document.externalUpdatedAt ?? document.updatedAt,
      });
    }
    if (document.externalSyncStatus === "missing") {
      diagnostics.push({
        id: `diagnostic:external-document-missing:${document.id}`,
        severity: "critical",
        title: "External document is unavailable",
        description: `${document.title} is marked as missing. Check the configured integration and resource binding.`,
        source: "external_document_permission",
        resourceNodeId: externalDocumentNodeId(document),
        lastChangedAt: document.externalUpdatedAt ?? document.updatedAt,
      });
    }
  }

  const now = Date.now();
  for (const token of listDaemonApiTokensSync(input.workspaceId)) {
    if (token.status !== "active") {
      continue;
    }
    const lastTouched = new Date(token.lastUsedAt ?? token.createdAt).getTime();
    if (Number.isNaN(lastTouched) || now - lastTouched <= 90 * 24 * 60 * 60 * 1000) {
      continue;
    }
    diagnostics.push({
      id: `diagnostic:stale-daemon-token:${token.id}`,
      severity: "warning",
      title: "Daemon token has not been used recently",
      description: `${token.label} is active but has no use in the last 90 days.`,
      source: "direct_grant",
      resourceNodeId: `daemon-token:${token.id}`,
      subjectType: "daemon_token",
      subjectId: token.id,
      lastChangedAt: token.lastUsedAt ?? token.createdAt,
    });
  }

  for (const channel of state.channels) {
    const participants = getChannelParticipants(context, channel.name);
    if (participants.length === 0) {
      continue;
    }
    const activeDisplayNames = participants
      .filter((participant) => participant.status === "active")
      .map((participant) => context.memberByUserId.get(participant.userId)?.displayName)
      .filter((displayName): displayName is string => Boolean(displayName));
    const legacyNames = resolveChannelHumanMemberNames(state, channel);
    const mismatch = legacyNames.some(
      (legacyName) => !activeDisplayNames.some((displayName) => sameValue(displayName, legacyName)),
    );
    if (mismatch) {
      diagnostics.push({
        id: `diagnostic:channel-legacy-participant-mismatch:${channel.name}`,
        severity: "warning",
        title: "Channel legacy member snapshot differs from participant rows",
        description: `${channel.name} still has legacy human member names that do not match active channel participants.`,
        source: "channel_participant",
        resourceNodeId: `channel:${channel.name}`,
      });
    }
  }

  if (state.channelDocumentAccesses.length > 0) {
    diagnostics.push({
      id: "diagnostic:document-access-state-json",
      severity: "info",
      title: "Document collaborators still live in workspace state",
      description: "Channel document collaborators are read from state_json in this version, so heavy concurrent edits should keep using the document service layer.",
      source: "system",
      resourceNodeId: context.workspaceNodeId,
    });
  }

  return context.isManager
    ? diagnostics
    : diagnostics.filter((diagnostic) => isDiagnosticVisibleToActor(diagnostic, context));
}

export function attachDiagnostics(
  node: PermissionTreeNode,
  diagnosticsByNode: Map<string, PermissionDiagnostic[]>,
): void {
  node.diagnostics = diagnosticsByNode.get(node.id) ?? [];
  if (node.diagnostics.length > 0 && node.diagnostics.some((diagnostic) => diagnostic.severity === "critical")) {
    node.status = "error";
  }
  for (const child of node.children ?? []) {
    attachDiagnostics(child, diagnosticsByNode);
  }
}

export function groupDiagnosticsByNode(diagnostics: PermissionDiagnostic[]): Map<string, PermissionDiagnostic[]> {
  const map = new Map<string, PermissionDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    if (!diagnostic.resourceNodeId) {
      continue;
    }
    const next = map.get(diagnostic.resourceNodeId) ?? [];
    next.push(diagnostic);
    map.set(diagnostic.resourceNodeId, next);
  }
  return map;
}

function isDiagnosticVisibleToActor(
  diagnostic: PermissionDiagnostic,
  context: PermissionBuildContext,
): boolean {
  if (diagnostic.subjectType === "human") {
    return diagnostic.subjectId === context.actor.userId || diagnostic.subjectId === `human:${context.actor.displayName}`;
  }
  if (diagnostic.subjectType === "agent") {
    return context.visibleEmployees.some((employee) => employee.name === diagnostic.subjectId);
  }
  if (diagnostic.resourceNodeId?.startsWith("document:")) {
    const documentId = diagnostic.resourceNodeId.slice("document:".length);
    const document = context.state.channelDocuments.find((item) => item.id === documentId);
    return document ? documentVisibleToActor(document, context) : false;
  }
  return diagnostic.resourceNodeId === context.workspaceNodeId;
}
