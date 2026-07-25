import {
  acceptAgentForkInvitationSync,
  createAgentForkInvitationSync,
  listAgentForkInvitationsSync,
  listStoredAgentKnowledgePageAssignmentsSync,
  listStoredAgentSkillAssignmentsSync,
  readAgentForkInvitationSync,
  readAgentForkSnapshotByInvitationSync,
  readAgentRuntimeSync,
  readStoredEmployeeSync,
  readUserSync,
  readWorkspaceMembershipSync,
  revokeAgentForkInvitationSync,
  type AgentForkInvitationStatus,
  type StoredAgentForkInvitationRecord,
} from "@dofe-agent/db";
import type { ActiveEmployee } from "@dofe-agent/domain/workspace";
import {
  bindEmployeeRuntimeSync,
  createEmployeeSync,
  setEmployeeSkillIdsSync,
} from "../employees/employees.ts";
import { postHumanDirectSystemMessageSync } from "../contacts/contacts.ts";
import {
  listKnowledgeAssignmentPoliciesSync,
  setEmployeeKnowledgePageIdsSync,
} from "../knowledge/assignments.ts";
import { createNotificationSync } from "../notifications/notifications.ts";
import {
  assertCanManageEmployeeForActorSync,
  assertCanUseRuntimeForActorSync,
  isWorkspaceAdminOrOwnerSync,
} from "../runtime-access/runtime-access.ts";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import { sameValue, uniqueStringValues } from "../shared/helpers.ts";
import { ensureWorkspaceStateSync } from "../shared/state-io.ts";
import { listWorkspaceSkillsSync } from "../skills/skills.ts";

export interface AgentForkOptions {
  copyProfile: boolean;
  copyInstructions: boolean;
  copySkills: boolean;
  copyKnowledgeAssignments: boolean;
  copyMemorySummary?: boolean;
  contextNote?: string;
}

export interface AgentForkSnapshot {
  profile?: Pick<ActiveEmployee, "name" | "role" | "remarkName" | "summary" | "traits" | "fit" | "origin">;
  instructions?: string;
  skillIds: string[];
  knowledgePageIds: string[];
  contextNote?: string;
}

export type AgentForkInvitationRecord = StoredAgentForkInvitationRecord & {
  options: AgentForkOptions;
  snapshot?: AgentForkSnapshot;
};

export function createAgentForkInvitationForActorSync(input: {
  workspaceId: string;
  sourceAgentName: string;
  targetUserId: string;
  actorUserId: string;
  options: AgentForkOptions;
}): AgentForkInvitationRecord {
  const workspaceId = input.workspaceId;
  const sourceAgentName = normalizeRequired(input.sourceAgentName, "sourceAgentName");
  const targetUserId = normalizeRequired(input.targetUserId, "targetUserId");
  const actorUserId = normalizeRequired(input.actorUserId, "actorUserId");
  const sourceAgent = readStoredEmployeeSync(sourceAgentName, workspaceId);
  if (!sourceAgent) {
    throw new Error("agent.fork.source_not_found");
  }
  assertCanManageEmployeeForActorSync({
    workspaceId,
    employeeName: sourceAgent.name,
    actorUserId,
  });
  if (sourceAgent.ownerUserId && sourceAgent.ownerUserId === targetUserId) {
    throw new Error("agent.fork.self_copy_requires_explicit_choice");
  }
  assertActiveWorkspaceMember(workspaceId, targetUserId);
  assertUserExists(targetUserId);

  const options = normalizeForkOptions(input.options);
  const nextSnapshot = buildAgentForkSnapshot(workspaceId, sourceAgent, options);
  const { invitation, snapshot, created } = createAgentForkInvitationSync({
    workspaceId,
    sourceAgentName: sourceAgent.name,
    targetUserId,
    createdByUserId: actorUserId,
    optionsJson: JSON.stringify(options),
    snapshotJson: JSON.stringify(nextSnapshot),
  });
  const persistedSnapshot = parseForkSnapshot(snapshot.snapshotJson);

  if (!created) {
    return {
      ...invitation,
      options: parseForkOptions(invitation.optionsJson),
      snapshot: persistedSnapshot,
    };
  }

  notifyForkInvitationCreated({
    workspaceId,
    invitation,
    sourceAgent,
    snapshot: persistedSnapshot,
  });
  recordForkAuditEvent({
    workspaceId,
    code: "agent.fork_invitation_created",
    title: "Agent fork invitation created",
    note: `Agent "${sourceAgent.name}" was offered to user "${targetUserId}" as a fork.`,
    invitation,
    snapshot: persistedSnapshot,
  });

  return { ...invitation, options, snapshot: persistedSnapshot };
}

export function acceptAgentForkInvitationForActorSync(input: {
  workspaceId: string;
  invitationId: string;
  actorUserId: string;
  newAgentName: string;
  runtimeId: string;
}): { invitation: AgentForkInvitationRecord; agentName: string } {
  const workspaceId = input.workspaceId;
  const invitationId = normalizeRequired(input.invitationId, "invitationId");
  const actorUserId = normalizeRequired(input.actorUserId, "actorUserId");
  const newAgentName = normalizeRequired(input.newAgentName, "newAgentName");
  const runtimeId = normalizeRequired(input.runtimeId, "runtimeId");
  const invitation = readPendingInvitation(workspaceId, invitationId);
  if (invitation.targetUserId !== actorUserId) {
    throw new Error("agent.fork.invitation_user_mismatch");
  }
  assertActiveWorkspaceMember(workspaceId, actorUserId);
  assertCanUseRuntimeForActorSync({ workspaceId, runtimeId, actorUserId });
  const runtime = readAgentRuntimeSync(runtimeId);
  if (!runtime || runtime.workspaceId !== workspaceId) {
    throw new Error("agent.fork.runtime_not_found");
  }
  const state = ensureWorkspaceStateSync(workspaceId);
  if (state.activeEmployees.some((employee) => sameValue(employee.name, newAgentName))) {
    throw new Error("agent.fork.agent_name_exists");
  }

  const snapshot = readSnapshotForInvitation(workspaceId, invitation.id);
  const existingSkillIds = new Set(listWorkspaceSkillsSync(workspaceId).map((skill) => skill.id));
  const skillIdsToCopy = snapshot.skillIds.filter((skillId) => existingSkillIds.has(skillId));
  const knowledgePolicyByPageId = new Map(
    listKnowledgeAssignmentPoliciesSync(workspaceId).map((policy) => [policy.knowledgePageId, policy]),
  );
  const existingSelectedKnowledgePageIds = new Set(state.knowledgePages
    .filter((page) => (knowledgePolicyByPageId.get(page.id)?.assignmentMode ?? page.assignmentMode ?? "all_agents") === "selected_agents")
    .map((page) => page.id));
  const knowledgePageIdsToCopy = snapshot.knowledgePageIds.filter((pageId) => existingSelectedKnowledgePageIds.has(pageId));
  const targetAgent = buildTargetAgentInput({
    newAgentName,
    invitation,
    snapshot,
    targetUserId: actorUserId,
    copiedSkillIds: skillIdsToCopy,
  });

  createEmployeeSync(targetAgent, workspaceId);
  if (skillIdsToCopy.length > 0) {
    setEmployeeSkillIdsSync(newAgentName, skillIdsToCopy, workspaceId);
  }
  if (knowledgePageIdsToCopy.length > 0) {
    setEmployeeKnowledgePageIdsSync(newAgentName, knowledgePageIdsToCopy, actorUserId, workspaceId);
  }
  bindEmployeeRuntimeSync(newAgentName, runtimeId, workspaceId);
  const accepted = acceptAgentForkInvitationSync({
    workspaceId,
    invitationId: invitation.id,
    acceptedAgentName: newAgentName,
    acceptedRuntimeId: runtimeId,
  });
  if (!accepted) {
    throw new Error("agent.fork.accept_failed");
  }

  notifyForkInvitationAccepted({
    workspaceId,
    invitation: accepted,
    snapshot,
    targetAgentName: newAgentName,
  });
  recordForkAuditEvent({
    workspaceId,
    code: "agent.fork_invitation_accepted",
    title: "Agent fork invitation accepted",
    note: `Agent fork invitation "${accepted.id}" was accepted as "${newAgentName}".`,
    invitation: accepted,
    snapshot,
    targetAgentName: newAgentName,
    runtimeId,
    copiedSkillCount: skillIdsToCopy.length,
    copiedKnowledgePageCount: knowledgePageIdsToCopy.length,
  });
  recordForkAuditEvent({
    workspaceId,
    code: "agent.fork_created",
    title: "Agent fork created",
    note: `Agent "${newAgentName}" was created from "${accepted.sourceAgentName}".`,
    invitation: accepted,
    snapshot,
    targetAgentName: newAgentName,
    runtimeId,
    copiedSkillCount: skillIdsToCopy.length,
    copiedKnowledgePageCount: knowledgePageIdsToCopy.length,
  });

  return {
    invitation: { ...accepted, options: parseForkOptions(accepted.optionsJson), snapshot },
    agentName: newAgentName,
  };
}

export function revokeAgentForkInvitationForActorSync(input: {
  workspaceId: string;
  invitationId: string;
  actorUserId: string;
}): AgentForkInvitationRecord {
  const workspaceId = input.workspaceId;
  const invitationId = normalizeRequired(input.invitationId, "invitationId");
  const actorUserId = normalizeRequired(input.actorUserId, "actorUserId");
  const invitation = readPendingInvitation(workspaceId, invitationId);
  if (
    invitation.createdByUserId !== actorUserId &&
    !isWorkspaceAdminOrOwnerSync({ workspaceId, userId: actorUserId })
  ) {
    throw new Error("agent.fork.revoke_forbidden");
  }
  const revoked = revokeAgentForkInvitationSync({ workspaceId, invitationId });
  if (!revoked) {
    throw new Error("agent.fork.revoke_failed");
  }
  const snapshot = readSnapshotForInvitation(workspaceId, revoked.id);
  notifyForkInvitationRevoked({ workspaceId, invitation: revoked, snapshot });
  recordForkAuditEvent({
    workspaceId,
    code: "agent.fork_invitation_revoked",
    title: "Agent fork invitation revoked",
    note: `Agent fork invitation "${revoked.id}" was revoked.`,
    invitation: revoked,
    snapshot,
  });
  return { ...revoked, options: parseForkOptions(revoked.optionsJson), snapshot };
}

export function listAgentForkInvitationsForActorSync(input: {
  workspaceId: string;
  actorUserId: string;
  statuses?: AgentForkInvitationStatus[];
}): AgentForkInvitationRecord[] {
  const workspaceId = input.workspaceId;
  const actorUserId = normalizeRequired(input.actorUserId, "actorUserId");
  const statuses = input.statuses ?? ["pending"];
  const manager = isWorkspaceAdminOrOwnerSync({ workspaceId, userId: actorUserId });
  const invitations = manager
    ? listAgentForkInvitationsSync(workspaceId, { statuses })
    : [
        ...listAgentForkInvitationsSync(workspaceId, { targetUserId: actorUserId, statuses }),
        ...listAgentForkInvitationsSync(workspaceId, { createdByUserId: actorUserId, statuses }),
      ];
  return dedupeInvitations(invitations).map((invitation) => hydrateInvitation(workspaceId, invitation));
}

export function listAgentForkInvitationsForSourceAgentSync(input: {
  workspaceId: string;
  sourceAgentName: string;
  actorUserId: string;
  statuses?: AgentForkInvitationStatus[];
}): AgentForkInvitationRecord[] {
  const workspaceId = input.workspaceId;
  const sourceAgentName = normalizeRequired(input.sourceAgentName, "sourceAgentName");
  const actorUserId = normalizeRequired(input.actorUserId, "actorUserId");
  assertCanManageEmployeeForActorSync({
    workspaceId,
    employeeName: sourceAgentName,
    actorUserId,
  });
  return listAgentForkInvitationsSync(workspaceId, {
    sourceAgentName,
    statuses: input.statuses ?? ["pending"],
  }).map((invitation) => hydrateInvitation(workspaceId, invitation));
}

function buildAgentForkSnapshot(
  workspaceId: string,
  sourceAgent: ActiveEmployee,
  options: AgentForkOptions,
): AgentForkSnapshot {
  return {
    profile: options.copyProfile
      ? {
          name: sourceAgent.name,
          role: sourceAgent.role,
          remarkName: sourceAgent.remarkName,
          summary: sourceAgent.summary,
          traits: [...sourceAgent.traits],
          fit: sourceAgent.fit,
          origin: sourceAgent.origin,
        }
      : undefined,
    instructions: options.copyInstructions ? sourceAgent.instructions ?? "" : undefined,
    skillIds: options.copySkills
      ? uniqueStringValues(
          listStoredAgentSkillAssignmentsSync(workspaceId)
            .filter((assignment) => assignment.employeeName === sourceAgent.name)
            .map((assignment) => assignment.skillId),
        )
      : [],
    knowledgePageIds: options.copyKnowledgeAssignments
      ? uniqueStringValues(
          listStoredAgentKnowledgePageAssignmentsSync(workspaceId)
            .filter((assignment) => assignment.employeeName === sourceAgent.name)
            .map((assignment) => assignment.knowledgePageId),
        )
      : [],
    contextNote: options.contextNote,
  };
}

function buildTargetAgentInput(input: {
  newAgentName: string;
  invitation: StoredAgentForkInvitationRecord;
  snapshot: AgentForkSnapshot;
  targetUserId: string;
  copiedSkillIds: string[];
}): Parameters<typeof createEmployeeSync>[0] {
  const profile = input.snapshot.profile;
  const instructions = [input.snapshot.instructions ?? "", formatContextNote(input.snapshot.contextNote)]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  return {
    name: input.newAgentName,
    role: profile?.role ?? "Agent",
    remarkName: profile?.remarkName ?? input.newAgentName,
    summary: profile?.summary ?? `Forked from ${input.invitation.sourceAgentName}.`,
    traits: profile?.traits ?? [],
    fit: profile?.fit ?? "Ready to collaborate immediately.",
    origin: `agent-fork:${input.invitation.sourceAgentName}:${input.invitation.id}`,
    instructions,
    skillIds: input.copiedSkillIds,
    ownerUserId: input.targetUserId,
    channelMemberAccess: "disabled",
    active: true,
  };
}

function formatContextNote(contextNote: string | undefined): string {
  const note = contextNote?.trim();
  return note ? `Fork context note:\n${note}` : "";
}

function readPendingInvitation(workspaceId: string, invitationId: string): StoredAgentForkInvitationRecord {
  const invitation = readAgentForkInvitationSync(invitationId, workspaceId);
  if (!invitation || invitation.status !== "pending") {
    throw new Error("agent.fork.invitation_not_found");
  }
  return invitation;
}

function readSnapshotForInvitation(workspaceId: string, invitationId: string): AgentForkSnapshot {
  const snapshot = readAgentForkSnapshotByInvitationSync(workspaceId, invitationId);
  if (!snapshot) {
    throw new Error("agent.fork.snapshot_not_found");
  }
  return parseForkSnapshot(snapshot.snapshotJson);
}

function hydrateInvitation(workspaceId: string, invitation: StoredAgentForkInvitationRecord): AgentForkInvitationRecord {
  return {
    ...invitation,
    options: parseForkOptions(invitation.optionsJson),
    snapshot: readAgentForkSnapshotByInvitationSync(workspaceId, invitation.id)
      ? readSnapshotForInvitation(workspaceId, invitation.id)
      : undefined,
  };
}

function notifyForkInvitationCreated(input: {
  workspaceId: string;
  invitation: StoredAgentForkInvitationRecord;
  sourceAgent: ActiveEmployee;
  snapshot: AgentForkSnapshot;
}): void {
  const creator = readUserSync(input.invitation.createdByUserId);
  createNotificationSync({
    workspaceId: input.workspaceId,
    recipientType: "human",
    recipientId: input.invitation.targetUserId,
    actorType: "human",
    actorId: input.invitation.createdByUserId,
    type: "agent.fork_invitation_created",
    resourceType: "agent_fork_invitation",
    resourceId: input.invitation.id,
    title: "Agent copy invitation",
    body: `${creator?.displayName ?? "A teammate"} invited you to copy ${input.sourceAgent.remarkName ?? input.sourceAgent.name}.`,
    actionHref: "/agents",
    severity: "info",
    dedupeKey: `agent.fork_invitation_created:${input.workspaceId}:${input.invitation.id}:${input.invitation.targetUserId}`,
    metadata: buildNotificationMetadata(input.invitation, input.snapshot),
  });
  postForkDirectSystemMessage({
    workspaceId: input.workspaceId,
    invitation: input.invitation,
    snapshot: input.snapshot,
    summary: `${creator?.displayName ?? "A teammate"} invited you to copy ${input.sourceAgent.remarkName ?? input.sourceAgent.name}.`,
    code: "agent.fork_invitation_created",
  });
}

function notifyForkInvitationAccepted(input: {
  workspaceId: string;
  invitation: StoredAgentForkInvitationRecord;
  snapshot: AgentForkSnapshot;
  targetAgentName: string;
}): void {
  if (input.invitation.createdByUserId === input.invitation.targetUserId) {
    return;
  }
  const target = readUserSync(input.invitation.targetUserId);
  createNotificationSync({
    workspaceId: input.workspaceId,
    recipientType: "human",
    recipientId: input.invitation.createdByUserId,
    actorType: "human",
    actorId: input.invitation.targetUserId,
    type: "agent.fork_invitation_accepted",
    resourceType: "agent_fork_invitation",
    resourceId: input.invitation.id,
    title: "Agent copy accepted",
    body: `${target?.displayName ?? "A teammate"} accepted the copy invitation and created ${input.targetAgentName}.`,
    actionHref: `/agents?focus=agent:${encodeURIComponent(input.targetAgentName)}`,
    severity: "success",
    dedupeKey: `agent.fork_invitation_accepted:${input.workspaceId}:${input.invitation.id}:${input.invitation.createdByUserId}`,
    metadata: {
      ...buildNotificationMetadata(input.invitation, input.snapshot),
      targetAgentName: input.targetAgentName,
    },
  });
  postForkDirectSystemMessage({
    workspaceId: input.workspaceId,
    invitation: input.invitation,
    snapshot: input.snapshot,
    summary: `${target?.displayName ?? "A teammate"} accepted the copy invitation and created ${input.targetAgentName}.`,
    code: "agent.fork_invitation_accepted",
    extraData: {
      targetAgentName: input.targetAgentName,
    },
  });
}

function notifyForkInvitationRevoked(input: {
  workspaceId: string;
  invitation: StoredAgentForkInvitationRecord;
  snapshot: AgentForkSnapshot;
}): void {
  createNotificationSync({
    workspaceId: input.workspaceId,
    recipientType: "human",
    recipientId: input.invitation.targetUserId,
    actorType: "human",
    actorId: input.invitation.createdByUserId,
    type: "agent.fork_invitation_revoked",
    resourceType: "agent_fork_invitation",
    resourceId: input.invitation.id,
    title: "Agent copy invitation revoked",
    body: `The copy invitation for ${input.invitation.sourceAgentName} was revoked.`,
    actionHref: "/agents",
    severity: "warning",
    dedupeKey: `agent.fork_invitation_revoked:${input.workspaceId}:${input.invitation.id}:${input.invitation.targetUserId}`,
    metadata: buildNotificationMetadata(input.invitation, input.snapshot),
  });
  postForkDirectSystemMessage({
    workspaceId: input.workspaceId,
    invitation: input.invitation,
    snapshot: input.snapshot,
    summary: `The copy invitation for ${input.invitation.sourceAgentName} was revoked.`,
    code: "agent.fork_invitation_revoked",
  });
}

function postForkDirectSystemMessage(input: {
  workspaceId: string;
  invitation: StoredAgentForkInvitationRecord;
  snapshot: AgentForkSnapshot;
  summary: string;
  code: string;
  extraData?: Record<string, string | undefined>;
}): void {
  if (input.invitation.createdByUserId === input.invitation.targetUserId) {
    return;
  }
  postHumanDirectSystemMessageSync({
    workspaceId: input.workspaceId,
    leftUserId: input.invitation.createdByUserId,
    rightUserId: input.invitation.targetUserId,
    summary: input.summary,
    code: input.code,
    data: {
      ...buildForkDirectMessageData(input.invitation, input.snapshot),
      ...input.extraData,
    },
  });
}

function recordForkAuditEvent(input: {
  workspaceId: string;
  code: string;
  title: string;
  note: string;
  invitation: StoredAgentForkInvitationRecord;
  snapshot: AgentForkSnapshot;
  targetAgentName?: string;
  runtimeId?: string;
  copiedSkillCount?: number;
  copiedKnowledgePageCount?: number;
}): void {
  const options = parseForkOptions(input.invitation.optionsJson);
  tryRecordWorkspaceAuditEventSync({
    workspaceId: input.workspaceId,
    title: input.title,
    note: input.note,
    code: input.code,
    data: {
      sourceAgentName: input.invitation.sourceAgentName,
      targetAgentName: input.targetAgentName ?? input.invitation.acceptedAgentName,
      targetUserId: input.invitation.targetUserId,
      createdByUserId: input.invitation.createdByUserId,
      runtimeId: input.runtimeId ?? input.invitation.acceptedRuntimeId,
      copiedSkillCount: input.copiedSkillCount ?? input.snapshot.skillIds.length,
      copiedKnowledgePageCount: input.copiedKnowledgePageCount ?? input.snapshot.knowledgePageIds.length,
      copyOptions: JSON.stringify(options),
      invitationId: input.invitation.id,
    },
  });
}

function buildForkDirectMessageData(
  invitation: StoredAgentForkInvitationRecord,
  snapshot: AgentForkSnapshot,
): Record<string, string> {
  const options = parseForkOptions(invitation.optionsJson);
  return {
    invitationId: invitation.id,
    sourceAgentName: invitation.sourceAgentName,
    targetUserId: invitation.targetUserId,
    createdByUserId: invitation.createdByUserId,
    copyProfile: String(options.copyProfile),
    copyInstructions: String(options.copyInstructions),
    copySkills: String(options.copySkills),
    copyKnowledgeAssignments: String(options.copyKnowledgeAssignments),
    copiedSkillCount: String(snapshot.skillIds.length),
    copiedKnowledgePageCount: String(snapshot.knowledgePageIds.length),
  };
}

function buildNotificationMetadata(
  invitation: StoredAgentForkInvitationRecord,
  snapshot: AgentForkSnapshot,
): Record<string, unknown> {
  return {
    invitationId: invitation.id,
    sourceAgentName: invitation.sourceAgentName,
    targetUserId: invitation.targetUserId,
    createdByUserId: invitation.createdByUserId,
    copiedSkillCount: snapshot.skillIds.length,
    copiedKnowledgePageCount: snapshot.knowledgePageIds.length,
    copyOptions: parseForkOptions(invitation.optionsJson),
  };
}

function assertActiveWorkspaceMember(workspaceId: string, userId: string): void {
  if (!readWorkspaceMembershipSync(workspaceId, userId)) {
    throw new Error("agent.fork.target_not_workspace_member");
  }
}

function assertUserExists(userId: string): void {
  if (!readUserSync(userId)) {
    throw new Error("agent.fork.target_user_not_found");
  }
}

function normalizeForkOptions(options: AgentForkOptions): AgentForkOptions {
  return {
    copyProfile: options.copyProfile !== false,
    copyInstructions: options.copyInstructions !== false,
    copySkills: options.copySkills !== false,
    copyKnowledgeAssignments: options.copyKnowledgeAssignments !== false,
    copyMemorySummary: options.copyMemorySummary === true,
    contextNote: options.contextNote?.trim() || undefined,
  };
}

function parseForkOptions(json: string): AgentForkOptions {
  try {
    const parsed = JSON.parse(json) as Partial<AgentForkOptions>;
    return normalizeForkOptions({
      copyProfile: parsed.copyProfile !== false,
      copyInstructions: parsed.copyInstructions !== false,
      copySkills: parsed.copySkills !== false,
      copyKnowledgeAssignments: parsed.copyKnowledgeAssignments !== false,
      copyMemorySummary: parsed.copyMemorySummary === true,
      contextNote: typeof parsed.contextNote === "string" ? parsed.contextNote : undefined,
    });
  } catch {
    return normalizeForkOptions({
      copyProfile: true,
      copyInstructions: true,
      copySkills: true,
      copyKnowledgeAssignments: true,
    });
  }
}

function parseForkSnapshot(json: string): AgentForkSnapshot {
  const parsed = JSON.parse(json) as Partial<AgentForkSnapshot>;
  const profile = parsed.profile && typeof parsed.profile === "object" ? parsed.profile : undefined;
  return {
    profile: profile
      ? {
          name: typeof profile.name === "string" ? profile.name : "",
          role: typeof profile.role === "string" ? profile.role : "Agent",
          remarkName: typeof profile.remarkName === "string" ? profile.remarkName : undefined,
          summary: typeof profile.summary === "string" ? profile.summary : "",
          traits: Array.isArray(profile.traits) ? profile.traits.filter((item): item is string => typeof item === "string") : [],
          fit: typeof profile.fit === "string" ? profile.fit : "",
          origin: typeof profile.origin === "string" ? profile.origin : "manual",
        }
      : undefined,
    instructions: typeof parsed.instructions === "string" ? parsed.instructions : undefined,
    skillIds: Array.isArray(parsed.skillIds) ? parsed.skillIds.filter((item): item is string => typeof item === "string") : [],
    knowledgePageIds: Array.isArray(parsed.knowledgePageIds)
      ? parsed.knowledgePageIds.filter((item): item is string => typeof item === "string")
      : [],
    contextNote: typeof parsed.contextNote === "string" ? parsed.contextNote : undefined,
  };
}

function dedupeInvitations(invitations: StoredAgentForkInvitationRecord[]): StoredAgentForkInvitationRecord[] {
  const seen = new Set<string>();
  const result: StoredAgentForkInvitationRecord[] = [];
  for (const invitation of invitations) {
    if (seen.has(invitation.id)) {
      continue;
    }
    seen.add(invitation.id);
    result.push(invitation);
  }
  return result;
}

function normalizeRequired(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}
