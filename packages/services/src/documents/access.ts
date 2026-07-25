import { allowsDocumentAction, type ChannelDocumentAccessRole } from "@dofe-agent/domain";
import type { DofeAgentState, ChannelDocument } from "@dofe-agent/domain/workspace";
import { sameValue } from "../shared/helpers.ts";
import { resolveChannelHumanMemberNames } from "../channels/channels.ts";

export function ensureChannelDocumentAccessSeeds(state: DofeAgentState): boolean {
  let changed = false;

  for (const document of state.channelDocuments) {
    const existing = state.channelDocumentAccesses.filter((access) => access.documentId === document.id);
    if (existing.length > 0) {
      continue;
    }

    state.channelDocumentAccesses.unshift(...buildDefaultDocumentAccesses(state, document));
    changed = true;
  }

  return changed;
}

export function listChannelDocumentAccesses(
  state: DofeAgentState,
  documentId: string,
): DofeAgentState["channelDocumentAccesses"] {
  return state.channelDocumentAccesses
    .filter((access) => access.documentId === documentId)
    .sort((left, right) => {
      const leftRank = roleRank(left.role);
      const rightRank = roleRank(right.role);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.actorId.localeCompare(right.actorId, "zh-CN", { sensitivity: "base" });
    });
}

export function resolveChannelDocumentRole(
  state: DofeAgentState,
  documentId: string,
  actorId: string,
  actorType: "human" | "agent",
): ChannelDocumentAccessRole | null {
  const access = state.channelDocumentAccesses.find(
    (item) =>
      item.documentId === documentId &&
      item.actorType === actorType &&
      sameValue(item.actorId, actorId),
  );
  return access?.role ?? null;
}

export function canViewChannelDocument(
  state: DofeAgentState,
  document: ChannelDocument,
  actorId: string,
  actorType: "human" | "agent",
): boolean {
  const role = resolveChannelDocumentRole(state, document.id, actorId, actorType);
  return allowsDocumentAction(normalizeEffectiveChannelRole(role, actorType), "view");
}

export function assertCanViewChannelDocument(
  state: DofeAgentState,
  document: ChannelDocument,
  actorId: string,
  actorType: "human" | "agent",
): void {
  if (canViewChannelDocument(state, document, actorId, actorType)) {
    return;
  }
  throw new Error(`Actor "${actorId}" does not have permission to view "${document.title}".`);
}

export function assertCanCreateChannelDocument(
  state: DofeAgentState,
  channelName: string,
  actorId: string,
  actorType: "human" | "agent",
): void {
  const channel = state.channels.find((item) => sameValue(item.name, channelName));
  if (actorType === "human") {
    const visibleHumans = channel ? resolveChannelHumanMemberNames(state, channel) : [];
    if (visibleHumans.some((name) => sameValue(name, actorId))) {
      return;
    }
  } else {
    const employee = state.activeEmployees.find((item) => sameValue(item.name, actorId));
    if (employee && employee.channels.some((channel) => sameValue(channel, channelName))) {
      return;
    }
  }

  throw new Error(`Actor "${actorId}" cannot create channel documents in ${channelName}.`);
}

export function assertCanEditChannelDocument(
  state: DofeAgentState,
  document: ChannelDocument,
  actorId: string,
  actorType: "human" | "agent",
): void {
  const role = resolveChannelDocumentRole(state, document.id, actorId, actorType);
  if (allowsDocumentAction(normalizeEffectiveChannelRole(role, actorType), "edit")) {
    return;
  }
  throw new Error(`Actor "${actorId}" does not have permission to edit "${document.title}".`);
}

export function assertCanManageChannelDocument(
  state: DofeAgentState,
  document: ChannelDocument,
  actorId: string,
  actorType: "human" | "agent",
): void {
  const role = resolveChannelDocumentRole(state, document.id, actorId, actorType);
  if (allowsDocumentAction(normalizeEffectiveChannelRole(role, actorType), "manage")) {
    return;
  }
  throw new Error(`Actor "${actorId}" does not have permission to manage "${document.title}".`);
}

export function upsertChannelDocumentAccessRole(
  state: DofeAgentState,
  input: {
    documentId: string;
    actorId: string;
    actorType: "human" | "agent";
    role: ChannelDocumentAccessRole;
  },
): DofeAgentState["channelDocumentAccesses"][number] {
  assertAccessTargetExists(state, input.actorId, input.actorType);
  assertAgentIsNotOwner(input.actorType, input.role);

  const existing = state.channelDocumentAccesses.find(
    (access) =>
      access.documentId === input.documentId &&
      access.actorType === input.actorType &&
      sameValue(access.actorId, input.actorId),
  );
  const now = new Date().toISOString();
  if (existing) {
    existing.role = input.role;
    existing.updatedAt = now;
    return existing;
  }

  const created = {
    id: `channel-doc-access-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    documentId: input.documentId,
    actorId: input.actorId,
    actorType: input.actorType,
    role: input.role,
    createdAt: now,
    updatedAt: now,
  } satisfies DofeAgentState["channelDocumentAccesses"][number];
  state.channelDocumentAccesses.unshift(created);
  return created;
}

export function addChannelDocumentCollaborator(
  state: DofeAgentState,
  input: {
    documentId: string;
    actorId: string;
    actorType: "human" | "agent";
    role: ChannelDocumentAccessRole;
  },
): DofeAgentState["channelDocumentAccesses"][number] {
  assertAgentIsNotOwner(input.actorType, input.role);
  const existing = state.channelDocumentAccesses.find(
    (access) =>
      access.documentId === input.documentId &&
      access.actorType === input.actorType &&
      sameValue(access.actorId, input.actorId),
  );
  if (existing) {
    throw new Error(`Document collaborator "${input.actorId}" already exists.`);
  }

  return upsertChannelDocumentAccessRole(state, input);
}

export function removeChannelDocumentCollaborator(
  state: DofeAgentState,
  input: {
    documentId: string;
    actorId: string;
    actorType: "human" | "agent";
  },
): DofeAgentState["channelDocumentAccesses"][number] {
  const existing = state.channelDocumentAccesses.find(
    (access) =>
      access.documentId === input.documentId &&
      access.actorType === input.actorType &&
      sameValue(access.actorId, input.actorId),
  );
  if (!existing) {
    throw new Error(`Document collaborator "${input.actorId}" does not exist.`);
  }

  state.channelDocumentAccesses = state.channelDocumentAccesses.filter((access) => access.id !== existing.id);
  return existing;
}

export function ensureDocumentKeepsAnOwner(
  state: DofeAgentState,
  documentId: string,
  nextActorId: string,
  nextActorType: "human" | "agent",
  nextRole: ChannelDocumentAccessRole,
): void {
  const owners = state.channelDocumentAccesses.filter(
    (access) =>
      access.documentId === documentId &&
      access.role === "owner" &&
      !(access.actorType === nextActorType && sameValue(access.actorId, nextActorId)),
  );
  if (nextRole === "owner" || owners.length > 0) {
    return;
  }
  throw new Error("A channel document must keep at least one owner.");
}

function buildDefaultDocumentAccesses(
  state: DofeAgentState,
  document: ChannelDocument,
): DofeAgentState["channelDocumentAccesses"] {
  const now = document.createdAt;
  const result: DofeAgentState["channelDocumentAccesses"] = [];
  const seen = new Set<string>();
  const channel = state.channels.find((item) => sameValue(item.name, document.channelName));
  const humanMemberNames = channel
    ? resolveChannelHumanMemberNames(state, channel)
    : state.humanMembers.map((member) => member.name);

  const ownerHuman =
    humanMemberNames.find((name) => sameValue(name, document.createdBy)) ?? humanMemberNames[0];
  if (ownerHuman) {
    result.push(createDocumentAccess(document.id, ownerHuman, "human", "owner", now));
    seen.add(`human:${ownerHuman.toLocaleLowerCase("zh-CN")}`);
  } else if (state.activeEmployees.some((employee) => sameValue(employee.name, document.createdBy))) {
    result.push(createDocumentAccess(document.id, document.createdBy, "agent", "editor", now));
    seen.add(`agent:${document.createdBy.toLocaleLowerCase("zh-CN")}`);
  }

  for (const memberName of humanMemberNames) {
    const key = `human:${memberName.toLocaleLowerCase("zh-CN")}`;
    if (seen.has(key)) {
      continue;
    }
    result.push(createDocumentAccess(document.id, memberName, "human", "editor", now));
    seen.add(key);
  }

  for (const employee of state.activeEmployees) {
    if (!employee.channels.some((channel) => sameValue(channel, document.channelName)) && !sameValue(employee.name, document.createdBy)) {
      continue;
    }
    const key = `agent:${employee.name.toLocaleLowerCase("zh-CN")}`;
    if (seen.has(key)) {
      continue;
    }
    result.push(createDocumentAccess(document.id, employee.name, "agent", "editor", now));
    seen.add(key);
  }

  return result;
}

function createDocumentAccess(
  documentId: string,
  actorId: string,
  actorType: "human" | "agent",
  role: ChannelDocumentAccessRole,
  now: string,
): DofeAgentState["channelDocumentAccesses"][number] {
  return {
    id: `channel-doc-access-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    documentId,
    actorId,
    actorType,
    role,
    createdAt: now,
    updatedAt: now,
  };
}

function assertAccessTargetExists(
  state: DofeAgentState,
  actorId: string,
  actorType: "human" | "agent",
): void {
  if (actorType === "human") {
    if (state.humanMembers.some((member) => sameValue(member.name, actorId))) {
      return;
    }
    if (state.channels.some((channel) => resolveChannelHumanMemberNames(state, channel).some((name) => sameValue(name, actorId)))) {
      return;
    }
  } else if (state.activeEmployees.some((employee) => sameValue(employee.name, actorId))) {
    return;
  }

  throw new Error(`Document collaborator "${actorId}" does not exist.`);
}

function roleRank(role: ChannelDocumentAccessRole): number {
  if (role === "owner") {
    return 0;
  }
  if (role === "forwarder") {
    return 1;
  }
  if (role === "editor") {
    return 2;
  }
  return 3;
}

function assertAgentIsNotOwner(actorType: "human" | "agent", role: ChannelDocumentAccessRole): void {
  if (actorType === "agent" && role === "owner") {
    throw new Error("Agents cannot be granted owner access to channel documents.");
  }
}

function normalizeEffectiveChannelRole(
  role: ChannelDocumentAccessRole | null,
  actorType: "human" | "agent",
): ChannelDocumentAccessRole | null {
  if (actorType === "agent" && role === "owner") {
    return null;
  }
  return role;
}
