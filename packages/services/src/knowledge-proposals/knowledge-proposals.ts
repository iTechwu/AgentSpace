import {
  buildTaskExecutionEventContext,
  createKnowledgeProposalSync,
  DEFAULT_WORKSPACE_ID,
  decideKnowledgeProposalSync,
  listKnowledgeProposalsSync,
  listWorkspaceMembershipsSync,
  readKnowledgeProposalSync as readStoredKnowledgeProposalSync,
  readQueuedTaskSync,
  readUserSync,
  updateKnowledgeProposalApprovalIdSync,
  type KnowledgeProposalRecord,
  type KnowledgeProposalStatus,
  type WorkspaceRole,
} from "@dofe-agent/db";
import type { KnowledgeAssignmentMode, KnowledgePage } from "@dofe-agent/domain/workspace";
import { createApprovalRequestSync, reviewApprovalSync } from "../approvals/approvals.ts";
import { setKnowledgePageAssignedEmployeesSync, setKnowledgePageAssignmentModeSync } from "../knowledge/assignments.ts";
import { createKnowledgePageSync, updateKnowledgePageSync } from "../knowledge/knowledge.ts";
import { createNotificationsSync, postNotificationChannelMessageSync } from "../notifications/notifications.ts";
import { ensureWorkspaceStateSync } from "../shared/state-io.ts";
import { createOpaqueId, sameValue, uniqueStringValues } from "../shared/helpers.ts";
import { tryRecordWorkspaceAuditEventSync } from "../shared/audit.ts";
import { recordTaskExecutionEventSync } from "../task-execution-events.ts";

export type KnowledgeProposalOperation = "create" | "update";

export interface CreateKnowledgeProposalFromAgentInput {
  workspaceId?: string;
  sourceTaskQueueId: string;
  sourceChannelName?: string;
  sourceAgentName: string;
  operation: KnowledgeProposalOperation;
  title: string;
  contentMarkdown: string;
  summary?: string;
  reason?: string;
  tags?: string[];
  parentId?: string | null;
  assignmentMode?: KnowledgeAssignmentMode;
  assignedEmployeeNames?: string[];
  assignToSelf?: boolean;
  targetKnowledgePageId?: string;
  baseUpdatedAt?: string;
}

export interface ApproveKnowledgeProposalInput {
  workspaceId?: string;
  proposalId: string;
  actor: {
    userId: string;
    displayName?: string;
    role?: WorkspaceRole;
  };
  reviewerComment?: string;
  title?: string;
  contentMarkdown?: string;
  tags?: string[];
  parentId?: string | null;
  assignmentMode?: KnowledgeAssignmentMode;
  assignedEmployeeNames?: string[];
}

export interface RejectKnowledgeProposalInput {
  workspaceId?: string;
  proposalId: string;
  actor: {
    userId: string;
    displayName?: string;
    role?: WorkspaceRole;
  };
  reviewerComment?: string;
}

export interface KnowledgeProposalApprovalResult {
  proposal: KnowledgeProposalRecord;
  knowledgePage?: KnowledgePage;
}

const DEFAULT_SELECTED_ASSIGN_TO_SELF = true;

export function createKnowledgeProposalFromAgentSync(
  input: CreateKnowledgeProposalFromAgentInput,
): KnowledgeProposalRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const state = ensureWorkspaceStateSync(workspaceId);
  const task = readQueuedTaskSync(input.sourceTaskQueueId);
  if (!task || task.workspaceId !== workspaceId) {
    throw new Error(`Source task "${input.sourceTaskQueueId}" does not exist in this workspace.`);
  }

  const sourceAgent = state.activeEmployees.find((employee) => sameValue(employee.name, input.sourceAgentName));
  if (!sourceAgent) {
    throw new Error(`Agent "${input.sourceAgentName}" does not exist.`);
  }

  const sourceChannelName = input.sourceChannelName?.trim();
  if (sourceChannelName && !state.channels.some((channel) => sameValue(channel.name, sourceChannelName))) {
    throw new Error(`Channel "${sourceChannelName}" does not exist.`);
  }

  const operation = normalizeOperation(input.operation);
  const title = requireTrimmed(input.title, "Knowledge proposal title");
  const contentMarkdown = requireMarkdownContent(input.contentMarkdown);
  assertNoSensitiveKnowledgeProposalText(title, "Knowledge proposal title");
  assertNoSensitiveKnowledgeProposalText(contentMarkdown, "Knowledge proposal content");
  assertNoSensitiveKnowledgeProposalText(input.summary, "Knowledge proposal summary");
  assertNoSensitiveKnowledgeProposalText(input.reason, "Knowledge proposal reason");
  const tags = normalizeStringList(input.tags);
  const parentId = normalizeParentId(state, input.parentId);
  const assignmentMode = input.assignmentMode ?? "selected_agents";
  const assignedEmployeeNames = normalizeAssignmentEmployees({
    state,
    assignmentMode,
    sourceAgentName: sourceAgent.name,
    assignedEmployeeNames: input.assignedEmployeeNames,
    assignToSelf: input.assignToSelf,
  });

  validateOperationTarget({
    state,
    operation,
    targetKnowledgePageId: input.targetKnowledgePageId,
    baseUpdatedAt: input.baseUpdatedAt,
  });

  const proposal = createKnowledgeProposalSync({
    workspaceId,
    sourceTaskQueueId: task.id,
    sourceChannelName,
    sourceAgentName: sourceAgent.name,
    operation,
    title,
    contentMarkdown,
    summary: input.summary,
    reason: input.reason,
    tags,
    parentId,
    assignmentMode,
    assignedEmployeeNames,
    targetKnowledgePageId: input.targetKnowledgePageId,
    baseUpdatedAt: input.baseUpdatedAt,
  });
  const approvalState = createApprovalRequestSync({
    type: "knowledge_proposal",
    sourceId: task.id,
    agentId: sourceAgent.name,
    channelName: resolveApprovalChannelName(state, sourceChannelName || resolveTaskChannelName(task)),
    contentPreview: buildProposalPreview(proposal),
    metadata: {
      proposalId: proposal.id,
      operation: proposal.operation,
      title: proposal.title,
      assignmentMode: proposal.assignmentMode,
      assignedEmployeeNames: proposal.assignedEmployeeNames,
      targetKnowledgePageId: proposal.targetKnowledgePageId,
      baseUpdatedAt: proposal.baseUpdatedAt,
    },
  }, workspaceId);
  const approval = approvalState.approvals[0];
  if (!approval) {
    throw new Error("Knowledge proposal approval could not be created.");
  }
  const linkedProposal = updateKnowledgeProposalApprovalIdSync({
    workspaceId,
    proposalId: proposal.id,
    approvalId: approval.id,
  });

  notifyKnowledgeProposalRequested(linkedProposal);
  postKnowledgeProposalChannelMessage(linkedProposal, "knowledge.proposal_requested");
  recordKnowledgeProposalEvent(linkedProposal, {
    type: "approval_requested",
    title: "Knowledge proposal requested",
    summary: `${linkedProposal.sourceAgentName} proposed workspace knowledge: ${linkedProposal.title}`,
    severity: "warning",
    status: "pending",
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: "Knowledge proposal requested",
    note: `${linkedProposal.sourceAgentName} proposed "${linkedProposal.title}".`,
    code: "knowledge.proposal_requested",
    data: {
      proposalId: linkedProposal.id,
      approvalId: linkedProposal.approvalId,
      sourceTaskQueueId: linkedProposal.sourceTaskQueueId,
      sourceAgentName: linkedProposal.sourceAgentName,
      operation: linkedProposal.operation,
    },
  });

  return linkedProposal;
}

export function listPendingKnowledgeProposalsForApproverSync(input: {
  workspaceId?: string;
  actor?: { userId?: string; role?: WorkspaceRole };
}): KnowledgeProposalRecord[] {
  if (input.actor?.userId && !isManagerRole(input.actor.role)) {
    return [];
  }
  return listKnowledgeProposalsSync(input.workspaceId ?? DEFAULT_WORKSPACE_ID, { statuses: ["pending"] });
}

export function listKnowledgeProposalsForWorkspaceSync(input: {
  workspaceId?: string;
  statuses?: KnowledgeProposalStatus[];
} = {}): KnowledgeProposalRecord[] {
  return listKnowledgeProposalsSync(input.workspaceId ?? DEFAULT_WORKSPACE_ID, { statuses: input.statuses });
}

export function readKnowledgeProposalSync(
  proposalId: string,
  workspaceId = DEFAULT_WORKSPACE_ID,
): KnowledgeProposalRecord | null {
  return readStoredKnowledgeProposalSync(proposalId, workspaceId);
}

export function approveKnowledgeProposalForActorSync(
  input: ApproveKnowledgeProposalInput,
): KnowledgeProposalApprovalResult {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  assertManagerActor(input.actor);
  const proposal = assertPendingProposal(input.proposalId, workspaceId);
  const state = ensureWorkspaceStateSync(workspaceId);
  const title = input.title?.trim() || proposal.title;
  const contentMarkdown = typeof input.contentMarkdown === "string" ? requireMarkdownContent(input.contentMarkdown) : proposal.contentMarkdown;
  const tags = input.tags ? normalizeStringList(input.tags) : proposal.tags;
  const parentId = input.parentId !== undefined ? normalizeParentId(state, input.parentId) : proposal.parentId;
  const assignmentMode = input.assignmentMode ?? proposal.assignmentMode;
  const assignedEmployeeNames = normalizeAssignmentEmployees({
    state,
    assignmentMode,
    sourceAgentName: proposal.sourceAgentName,
    assignedEmployeeNames: input.assignedEmployeeNames ?? proposal.assignedEmployeeNames,
    assignToSelf: false,
  });

  const knowledgePage = proposal.operation === "create"
    ? createProposalKnowledgePage({
        workspaceId,
        title,
        contentMarkdown,
        tags,
        parentId,
        proposal,
        actorUserId: input.actor.userId,
        assignmentMode,
        assignedEmployeeNames,
      })
    : updateProposalKnowledgePage({
        workspaceId,
        title,
        contentMarkdown,
        tags,
        proposal,
        actorUserId: input.actor.userId,
        assignmentMode,
        assignedEmployeeNames,
      });

  const decided = decideKnowledgeProposalSync({
    workspaceId,
    proposalId: proposal.id,
    status: "approved",
    decidedByUserId: input.actor.userId,
    reviewerComment: input.reviewerComment,
    createdKnowledgePageId: knowledgePage.id,
  });
  if (proposal.approvalId) {
    reviewApprovalSync(proposal.approvalId, "approved", input.reviewerComment, workspaceId);
  }
  notifyKnowledgeProposalDecided(decided, "approved", knowledgePage.id);
  postKnowledgeProposalChannelMessage(decided, "knowledge.proposal_approved", knowledgePage.id);
  recordKnowledgeProposalEvent(decided, {
    type: "approval_reviewed",
    title: "Knowledge proposal approved",
    summary: `Knowledge page "${knowledgePage.title}" is now available.`,
    status: "succeeded",
    data: {
      knowledgePageId: knowledgePage.id,
      reviewerComment: input.reviewerComment,
    },
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: "Knowledge proposal approved",
    note: `${input.actor.displayName ?? input.actor.userId} approved "${decided.title}".`,
    code: "knowledge.proposal_approved",
    data: {
      proposalId: decided.id,
      approvalId: decided.approvalId,
      knowledgePageId: knowledgePage.id,
      decidedByUserId: input.actor.userId,
    },
  });

  return { proposal: decided, knowledgePage };
}

export function rejectKnowledgeProposalForActorSync(input: RejectKnowledgeProposalInput): KnowledgeProposalRecord {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  assertManagerActor(input.actor);
  const proposal = assertPendingProposal(input.proposalId, workspaceId);
  const decided = decideKnowledgeProposalSync({
    workspaceId,
    proposalId: proposal.id,
    status: "rejected",
    decidedByUserId: input.actor.userId,
    reviewerComment: input.reviewerComment,
  });
  if (proposal.approvalId) {
    reviewApprovalSync(proposal.approvalId, "rejected", input.reviewerComment, workspaceId);
  }
  notifyKnowledgeProposalDecided(decided, "rejected");
  postKnowledgeProposalChannelMessage(decided, "knowledge.proposal_rejected");
  recordKnowledgeProposalEvent(decided, {
    type: "approval_reviewed",
    title: "Knowledge proposal rejected",
    summary: input.reviewerComment
      ? `Knowledge proposal "${decided.title}" was rejected: ${input.reviewerComment}`
      : `Knowledge proposal "${decided.title}" was rejected.`,
    severity: "warning",
    status: "failed",
    data: {
      reviewerComment: input.reviewerComment,
    },
  });
  tryRecordWorkspaceAuditEventSync({
    workspaceId,
    title: "Knowledge proposal rejected",
    note: `${input.actor.displayName ?? input.actor.userId} rejected "${decided.title}".`,
    code: "knowledge.proposal_rejected",
    data: {
      proposalId: decided.id,
      approvalId: decided.approvalId,
      decidedByUserId: input.actor.userId,
    },
  });
  return decided;
}

function createProposalKnowledgePage(input: {
  workspaceId: string;
  title: string;
  contentMarkdown: string;
  tags: string[];
  parentId?: string;
  proposal: KnowledgeProposalRecord;
  actorUserId: string;
  assignmentMode: KnowledgeAssignmentMode;
  assignedEmployeeNames: string[];
}): KnowledgePage {
  const beforeIds = new Set(ensureWorkspaceStateSync(input.workspaceId).knowledgePages.map((page) => page.id));
  createKnowledgePageSync({
    title: input.title,
    parentId: input.parentId,
    contentMarkdown: input.contentMarkdown,
    tags: ["agent-proposed", ...input.tags],
    createdBy: input.actorUserId,
    assignmentMode: input.assignmentMode,
    assignedEmployeeNames: input.assignedEmployeeNames,
    sourceKnowledgeProposalId: input.proposal.id,
    sourceApprovalId: input.proposal.approvalId,
    sourceTaskQueueId: input.proposal.sourceTaskQueueId,
    sourceAgentName: input.proposal.sourceAgentName,
  }, input.workspaceId);
  const after = ensureWorkspaceStateSync(input.workspaceId).knowledgePages;
  const created = after.find((page) => !beforeIds.has(page.id) && page.title === input.title)
    ?? after.find((page) => !beforeIds.has(page.id));
  if (!created) {
    throw new Error("Knowledge page could not be read after approval.");
  }
  return created;
}

function updateProposalKnowledgePage(input: {
  workspaceId: string;
  title: string;
  contentMarkdown: string;
  tags: string[];
  proposal: KnowledgeProposalRecord;
  actorUserId: string;
  assignmentMode: KnowledgeAssignmentMode;
  assignedEmployeeNames: string[];
}): KnowledgePage {
  if (!input.proposal.targetKnowledgePageId) {
    throw new Error("Knowledge update proposal is missing targetKnowledgePageId.");
  }
  const current = ensureWorkspaceStateSync(input.workspaceId).knowledgePages.find((page) => page.id === input.proposal.targetKnowledgePageId);
  if (!current) {
    throw new Error(`Knowledge page "${input.proposal.targetKnowledgePageId}" does not exist.`);
  }
  if (input.proposal.baseUpdatedAt && !sameTimestamp(current.updatedAt, input.proposal.baseUpdatedAt)) {
    decideKnowledgeProposalSync({
      workspaceId: input.workspaceId,
      proposalId: input.proposal.id,
      status: "stale",
      decidedByUserId: input.actorUserId,
      reviewerComment: "Target knowledge page changed before approval.",
    });
    throw new Error("Knowledge proposal is stale because the target page changed before approval.");
  }
  updateKnowledgePageSync(input.proposal.targetKnowledgePageId, {
    title: input.title,
    contentMarkdown: input.contentMarkdown,
    tags: ["agent-proposed", ...input.tags],
    sourceKnowledgeProposalId: input.proposal.id,
    sourceApprovalId: input.proposal.approvalId,
    sourceTaskQueueId: input.proposal.sourceTaskQueueId,
    sourceAgentName: input.proposal.sourceAgentName,
  }, input.workspaceId);
  setKnowledgePageAssignmentModeSync(input.proposal.targetKnowledgePageId, input.assignmentMode, input.actorUserId, input.workspaceId);
  if (input.assignmentMode === "selected_agents") {
    setKnowledgePageAssignedEmployeesSync(input.proposal.targetKnowledgePageId, input.assignedEmployeeNames, input.actorUserId, input.workspaceId);
  }
  const updated = ensureWorkspaceStateSync(input.workspaceId).knowledgePages.find((page) => page.id === input.proposal.targetKnowledgePageId);
  if (!updated) {
    throw new Error("Knowledge page could not be read after update.");
  }
  return updated;
}

function assertPendingProposal(proposalId: string, workspaceId: string): KnowledgeProposalRecord {
  const proposal = readStoredKnowledgeProposalSync(proposalId, workspaceId);
  if (!proposal) {
    throw new Error(`Knowledge proposal "${proposalId}" does not exist.`);
  }
  if (proposal.status !== "pending") {
    throw new Error(`Knowledge proposal "${proposalId}" is already ${proposal.status}.`);
  }
  return proposal;
}

function sameTimestamp(left: string, right: string): boolean {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
    return left === right;
  }
  return leftTime === rightTime;
}

function validateOperationTarget(input: {
  state: ReturnType<typeof ensureWorkspaceStateSync>;
  operation: KnowledgeProposalOperation;
  targetKnowledgePageId?: string;
  baseUpdatedAt?: string;
}): void {
  if (input.operation === "create") {
    return;
  }
  if (!input.targetKnowledgePageId?.trim()) {
    throw new Error("Update proposals require targetKnowledgePageId.");
  }
  if (!input.baseUpdatedAt?.trim()) {
    throw new Error("Update proposals require baseUpdatedAt.");
  }
  if (!input.state.knowledgePages.some((page) => page.id === input.targetKnowledgePageId)) {
    throw new Error(`Knowledge page "${input.targetKnowledgePageId}" does not exist.`);
  }
}

function normalizeParentId(
  state: ReturnType<typeof ensureWorkspaceStateSync>,
  parentId: string | null | undefined,
): string | undefined {
  const normalized = parentId?.trim();
  if (!normalized) {
    return undefined;
  }
  if (!state.knowledgePages.some((page) => page.id === normalized)) {
    throw new Error(`Parent knowledge page "${normalized}" does not exist.`);
  }
  return normalized;
}

function normalizeAssignmentEmployees(input: {
  state: ReturnType<typeof ensureWorkspaceStateSync>;
  assignmentMode: KnowledgeAssignmentMode;
  sourceAgentName: string;
  assignedEmployeeNames?: string[];
  assignToSelf?: boolean;
}): string[] {
  if (input.assignmentMode === "all_agents") {
    return [];
  }
  const requested = uniqueStringValues(input.assignedEmployeeNames ?? []);
  const shouldAssignToSelf = input.assignToSelf ?? DEFAULT_SELECTED_ASSIGN_TO_SELF;
  const withSelf = shouldAssignToSelf && !requested.some((name) => sameValue(name, input.sourceAgentName))
    ? [input.sourceAgentName, ...requested]
    : requested;
  const resolved: string[] = [];
  for (const name of uniqueStringValues(withSelf)) {
    const employee = input.state.activeEmployees.find((item) => sameValue(item.name, name));
    if (!employee) {
      throw new Error(`Assigned agent "${name}" does not exist.`);
    }
    resolved.push(employee.name);
  }
  return resolved;
}

function notifyKnowledgeProposalRequested(proposal: KnowledgeProposalRecord): void {
  const recipients = listWorkspaceMembershipsSync(proposal.workspaceId)
    .filter((membership) => isManagerRole(membership.role))
    .map((membership) => readUserSync(membership.userId))
    .filter((user): user is NonNullable<ReturnType<typeof readUserSync>> => Boolean(user));

  createNotificationsSync(recipients.map((recipient) => ({
    workspaceId: proposal.workspaceId,
    recipientType: "human",
    recipientId: recipient.id,
    actorType: "agent",
    actorId: proposal.sourceAgentName,
    type: "knowledge.proposal_requested",
    resourceType: "approval",
    resourceId: proposal.approvalId ?? proposal.id,
    channelName: proposal.sourceChannelName,
    title: "Knowledge proposal requested",
    body: `${proposal.sourceAgentName} proposed workspace knowledge: ${proposal.title}.`,
    actionHref: "/approvals",
    severity: proposal.assignmentMode === "all_agents" ? "warning" : "info",
    dedupeKey: `knowledge.proposal_requested:${proposal.workspaceId}:${proposal.id}:${recipient.id}`,
    metadata: {
      proposalId: proposal.id,
      approvalId: proposal.approvalId,
      operation: proposal.operation,
      sourceAgentName: proposal.sourceAgentName,
      sourceTaskQueueId: proposal.sourceTaskQueueId,
      assignmentMode: proposal.assignmentMode,
    },
  })));
}

function notifyKnowledgeProposalDecided(
  proposal: KnowledgeProposalRecord,
  decision: "approved" | "rejected",
  knowledgePageId?: string,
): void {
  const state = ensureWorkspaceStateSync(proposal.workspaceId);
  const employee = state.activeEmployees.find((item) => sameValue(item.name, proposal.sourceAgentName));
  const owner = employee?.ownerUserId ? readUserSync(employee.ownerUserId) : null;
  const title = decision === "approved" ? "Knowledge proposal approved" : "Knowledge proposal rejected";
  const body = decision === "approved"
    ? `Knowledge proposal "${proposal.title}" was approved.`
    : `Knowledge proposal "${proposal.title}" was rejected${proposal.reviewerComment ? `: ${proposal.reviewerComment}` : ""}.`;

  createNotificationsSync([
    {
      workspaceId: proposal.workspaceId,
      recipientType: "agent",
      recipientId: proposal.sourceAgentName,
      actorType: "system",
      actorId: "knowledge",
      type: decision === "approved" ? "knowledge.proposal_approved" : "knowledge.proposal_rejected",
      resourceType: "approval",
      resourceId: proposal.approvalId ?? proposal.id,
      channelName: proposal.sourceChannelName,
      title,
      body,
      actionHref: knowledgePageId ? `/knowledge?page=${encodeURIComponent(knowledgePageId)}` : "/approvals",
      severity: decision === "approved" ? "success" : "warning",
      dedupeKey: `knowledge.proposal_${decision}:${proposal.workspaceId}:${proposal.id}:${proposal.sourceAgentName}`,
      metadata: {
        proposalId: proposal.id,
        approvalId: proposal.approvalId,
        knowledgePageId,
        reviewerComment: proposal.reviewerComment,
      },
    },
    ...(owner
      ? [{
          workspaceId: proposal.workspaceId,
          recipientType: "human" as const,
          recipientId: owner.id,
          actorType: "system" as const,
          actorId: "knowledge",
          type: decision === "approved" ? "knowledge.proposal_approved.owner" : "knowledge.proposal_rejected.owner",
          resourceType: "approval" as const,
          resourceId: proposal.approvalId ?? proposal.id,
          channelName: proposal.sourceChannelName,
          title,
          body,
          actionHref: knowledgePageId ? `/knowledge?page=${encodeURIComponent(knowledgePageId)}` : "/approvals",
          severity: decision === "approved" ? "success" as const : "warning" as const,
          dedupeKey: `knowledge.proposal_${decision}.owner:${proposal.workspaceId}:${proposal.id}:${owner.id}`,
          metadata: {
            proposalId: proposal.id,
            approvalId: proposal.approvalId,
            knowledgePageId,
            reviewerComment: proposal.reviewerComment,
          },
        }]
      : []),
  ]);
}

function postKnowledgeProposalChannelMessage(
  proposal: KnowledgeProposalRecord,
  code: "knowledge.proposal_requested" | "knowledge.proposal_approved" | "knowledge.proposal_rejected",
  knowledgePageId?: string,
): void {
  const statusText = code.endsWith("_approved")
    ? "approved"
    : code.endsWith("_rejected")
      ? "rejected"
      : "submitted for review";
  postNotificationChannelMessageSync({
    workspaceId: proposal.workspaceId,
    channelName: proposal.sourceChannelName ?? "",
    summary: `${proposal.sourceAgentName} ${statusText} knowledge proposal "${proposal.title}".`,
    code,
    data: {
      proposal_id: proposal.id,
      approval_id: proposal.approvalId,
      source_task_queue_id: proposal.sourceTaskQueueId,
      source_agent_name: proposal.sourceAgentName,
      knowledge_page_id: knowledgePageId,
      assignment_mode: proposal.assignmentMode,
    },
  });
}

function recordKnowledgeProposalEvent(
  proposal: KnowledgeProposalRecord,
  input: {
    type: Parameters<typeof recordTaskExecutionEventSync>[0]["type"];
    title: string;
    summary?: string;
    severity?: Parameters<typeof recordTaskExecutionEventSync>[0]["severity"];
    status?: Parameters<typeof recordTaskExecutionEventSync>[0]["status"];
    data?: Record<string, unknown>;
  },
): void {
  const task = readQueuedTaskSync(proposal.sourceTaskQueueId);
  if (!task) {
    return;
  }
  const context = buildTaskExecutionEventContext(task);
  recordTaskExecutionEventSync({
    ...context,
    type: input.type,
    title: input.title,
    summary: input.summary,
    severity: input.severity,
    status: input.status,
    data: {
      proposalId: proposal.id,
      approvalId: proposal.approvalId,
      operation: proposal.operation,
      sourceTaskQueueId: proposal.sourceTaskQueueId,
      sourceAgentName: proposal.sourceAgentName,
      assignmentMode: proposal.assignmentMode,
      ...input.data,
    },
  });
}

function buildProposalPreview(proposal: KnowledgeProposalRecord): string {
  const operation = proposal.operation === "create" ? "Create" : "Update";
  const scope = proposal.assignmentMode === "all_agents"
    ? "all agents"
    : proposal.assignedEmployeeNames.length > 0
      ? proposal.assignedEmployeeNames.join(", ")
      : "selected agents";
  const reason = proposal.reason ? ` Reason: ${proposal.reason}` : "";
  return `${operation} knowledge page "${proposal.title}" for ${scope}.${reason}`;
}

function assertManagerActor(actor: { userId: string; role?: WorkspaceRole }): void {
  if (!actor.userId?.trim()) {
    throw new Error("Reviewer user id is required.");
  }
  if (!isManagerRole(actor.role)) {
    throw new Error("Only workspace owners and admins can review knowledge proposals.");
  }
}

function isManagerRole(role: WorkspaceRole | undefined): boolean {
  return role === "owner" || role === "admin";
}

function normalizeOperation(value: KnowledgeProposalOperation): KnowledgeProposalOperation {
  if (value === "create" || value === "update") {
    return value;
  }
  throw new Error("Knowledge proposal operation must be create or update.");
}

function requireMarkdownContent(value: string): string {
  const content = value.trim();
  if (!content) {
    throw new Error("Knowledge proposal content is required.");
  }
  return content;
}

function assertNoSensitiveKnowledgeProposalText(value: string | undefined, label: string): void {
  if (!value) {
    return;
  }
  if (containsSensitiveTokenMaterial(value)) {
    throw new Error(`${label} appears to contain credential or token material.`);
  }
}

function containsSensitiveTokenMaterial(value: string): boolean {
  return [
    /GOOGLE_WORKSPACE_CLI_TOKEN/i,
    /"refresh_token"\s*:/i,
    /"access_token"\s*:/i,
    /"client_secret"\s*:/i,
    /"private_key"\s*:/i,
    /"credentials?"\s*:/i,
    /["']?authorization["']?\s*:\s*["']?(Bearer|Basic|ya29\.)/i,
    /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i,
    /\bya29\.[A-Za-z0-9._-]{20,}/i,
  ].some((pattern) => pattern.test(value));
}

function requireTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  return trimmed;
}

function normalizeStringList(value: string[] | undefined): string[] {
  return uniqueStringValues((value ?? []).filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean));
}

function resolveTaskChannelName(task: NonNullable<ReturnType<typeof readQueuedTaskSync>>): string | undefined {
  try {
    const parsed = JSON.parse(task.inputJson) as Record<string, unknown>;
    const channel = parsed.channelName ?? parsed.channel;
    return typeof channel === "string" && channel.trim() ? channel.trim() : undefined;
  } catch {
    return undefined;
  }
}

function resolveApprovalChannelName(
  state: ReturnType<typeof ensureWorkspaceStateSync>,
  preferred: string | undefined,
): string {
  if (preferred) {
    const channel = state.channels.find((item) => sameValue(item.name, preferred));
    if (channel) {
      return channel.name;
    }
  }
  const fallback = state.channels.find((channel) => channel.kind !== "direct") ?? state.channels[0];
  if (!fallback) {
    throw new Error("Knowledge proposal approvals require at least one workspace channel.");
  }
  return fallback.name;
}

export function createKnowledgeProposalIdForTests(): string {
  return `knowledge-proposal-${createOpaqueId()}`;
}
