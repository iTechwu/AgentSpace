import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  createUserSync,
  createWorkspaceMembershipSync,
  createWorkspaceSync,
  getDatabase,
  listWorkspaceNotificationsForRecipientSync,
  readStoredEmployeeSync,
} from "@dofe-agent/db";
import {
  approveAgentAccessRequestForActorSync,
  createAgentAccessRequestForActorSync,
  createEmployeeSync,
  listAgentAccessRequestsForActorSync,
  listAgentForkInvitationsForActorSync,
  resetWorkspaceStateSync,
  writeWorkspaceStateSync,
} from "../index.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-agent-access-request-service-"));
const originalCwd = process.cwd();

before(() => {
  process.env.DOFE_AGENT_REPOSITORY_ROOT = originalCwd;
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  getDatabase().exec(`
    DELETE FROM agent_access_request;
    DELETE FROM agent_fork_snapshot;
    DELETE FROM agent_fork_invitation;
    DELETE FROM workspace_notification;
    DELETE FROM workspace_employee;
    DELETE FROM workspace_snapshot;
    DELETE FROM workspace_membership;
    DELETE FROM workspace;
    DELETE FROM users;
  `);
});

test("agent access requests notify the source owner and approval creates a fork invitation", () => {
  const fixtures = seedAgentAccessRequestServiceWorkspace();

  const request = createAgentAccessRequestForActorSync({
    workspaceId: fixtures.workspaceId,
    sourceAgentName: "Planner",
    requesterUserId: fixtures.requester.id,
    reason: "Use this planner for launch checklists.",
  });
  const duplicate = createAgentAccessRequestForActorSync({
    workspaceId: fixtures.workspaceId,
    sourceAgentName: "Planner",
    requesterUserId: fixtures.requester.id,
    reason: "Use this planner for launch checklists.",
  });

  assert.equal(request.status, "pending");
  assert.equal(duplicate.id, request.id);
  assert.equal(
    listWorkspaceNotificationsForRecipientSync({
      workspaceId: fixtures.workspaceId,
      recipientType: "human",
      recipientId: fixtures.agentOwner.id,
    })[0]?.type,
    "agent.access_request_created",
  );

  assert.throws(() => approveAgentAccessRequestForActorSync({
    workspaceId: fixtures.workspaceId,
    requestId: request.id,
    actorUserId: fixtures.otherMember.id,
  }), /Only the agent owner or a workspace manager/);

  const approved = approveAgentAccessRequestForActorSync({
    workspaceId: fixtures.workspaceId,
    requestId: request.id,
    actorUserId: fixtures.agentOwner.id,
  });

  assert.equal(approved.status, "approved");
  assert.ok(approved.forkInvitationId);
  assert.equal(
    listAgentForkInvitationsForActorSync({
      workspaceId: fixtures.workspaceId,
      actorUserId: fixtures.requester.id,
    })[0]?.id,
    approved.forkInvitationId,
  );
  assert.equal(
    listAgentAccessRequestsForActorSync({
      workspaceId: fixtures.workspaceId,
      actorUserId: fixtures.requester.id,
    })[0]?.status,
    "approved",
  );
  assert.equal(
    listWorkspaceNotificationsForRecipientSync({
      workspaceId: fixtures.workspaceId,
      recipientType: "human",
      recipientId: fixtures.requester.id,
    }).some((notification) => notification.type === "agent.access_request_approved"),
    true,
  );
});

test("channel use requests require a shared channel and approval enables channel member access", () => {
  const fixtures = seedAgentAccessRequestServiceWorkspace();
  const state = createEmployeeSync({
    name: "Researcher",
    role: "Research Agent",
    remarkName: "Research Partner",
    summary: "Researches market context.",
    traits: ["research"],
    fit: "Market research",
    instructions: "Research carefully.",
    ownerUserId: fixtures.agentOwner.id,
    channelMemberAccess: "disabled",
  }, fixtures.workspaceId);
  writeWorkspaceStateSync({
    ...state,
    humanMembers: [
      { name: fixtures.agentOwner.displayName, role: "Owner" },
      { name: fixtures.requester.displayName, role: "Member" },
      { name: fixtures.otherMember.displayName, role: "Member" },
    ],
    channels: [
      {
        name: "research",
        humanMembers: 2,
        humanMemberNames: [fixtures.agentOwner.displayName, fixtures.requester.displayName],
        employeeNames: ["Researcher"],
      },
    ],
    activeEmployees: state.activeEmployees.map((employee) =>
      employee.name === "Researcher"
        ? { ...employee, channels: ["research"], channelMemberAccess: "disabled" as const }
        : employee
    ),
  }, fixtures.workspaceId);

  const request = createAgentAccessRequestForActorSync({
    workspaceId: fixtures.workspaceId,
    sourceAgentName: "Researcher",
    requesterUserId: fixtures.requester.id,
    requestType: "channel_use",
    targetChannelName: "research",
    reason: "Need to ask it for market notes in the research channel.",
  });

  assert.equal(request.status, "pending");
  assert.equal(request.requestType, "channel_use");
  assert.equal(request.targetChannelName, "research");
  assert.equal(readStoredEmployeeSync("Researcher", fixtures.workspaceId)?.channelMemberAccess, "disabled");

  const approved = approveAgentAccessRequestForActorSync({
    workspaceId: fixtures.workspaceId,
    requestId: request.id,
    actorUserId: fixtures.agentOwner.id,
  });

  assert.equal(approved.status, "approved");
  assert.equal(approved.forkInvitationId, undefined);
  assert.equal(readStoredEmployeeSync("Researcher", fixtures.workspaceId)?.channelMemberAccess, "enabled");
  assert.equal(
    listWorkspaceNotificationsForRecipientSync({
      workspaceId: fixtures.workspaceId,
      recipientType: "human",
      recipientId: fixtures.requester.id,
    }).some((notification) =>
      notification.type === "agent.access_request_approved" &&
      notification.body.includes("#research")
    ),
    true,
  );
});

test("channel use requests reject direct channels and channels without the source agent", () => {
  const fixtures = seedAgentAccessRequestServiceWorkspace();
  const state = createEmployeeSync({
    name: "Analyst",
    role: "Analysis Agent",
    ownerUserId: fixtures.agentOwner.id,
    channelMemberAccess: "disabled",
  }, fixtures.workspaceId);
  writeWorkspaceStateSync({
    ...state,
    humanMembers: [
      { name: fixtures.agentOwner.displayName, role: "Owner" },
      { name: fixtures.requester.displayName, role: "Member" },
    ],
    channels: [
      {
        name: "private-chat",
        kind: "direct",
        humanMembers: 1,
        humanMemberNames: [fixtures.requester.displayName],
        employeeNames: ["Analyst"],
      },
      {
        name: "ops",
        humanMembers: 1,
        humanMemberNames: [fixtures.requester.displayName],
        employeeNames: [],
      },
    ],
    activeEmployees: state.activeEmployees.map((employee) =>
      employee.name === "Analyst"
        ? { ...employee, channels: ["private-chat"], channelMemberAccess: "disabled" as const }
        : employee
    ),
  }, fixtures.workspaceId);

  assert.throws(() => createAgentAccessRequestForActorSync({
    workspaceId: fixtures.workspaceId,
    sourceAgentName: "Analyst",
    requesterUserId: fixtures.requester.id,
    requestType: "channel_use",
    targetChannelName: "private-chat",
  }), /direct_channel_not_supported/);

  assert.throws(() => createAgentAccessRequestForActorSync({
    workspaceId: fixtures.workspaceId,
    sourceAgentName: "Analyst",
    requesterUserId: fixtures.requester.id,
    requestType: "channel_use",
    targetChannelName: "ops",
  }), /source_not_in_channel/);
});

function seedAgentAccessRequestServiceWorkspace(): {
  workspaceId: string;
  agentOwner: ReturnType<typeof createUserSync>;
  requester: ReturnType<typeof createUserSync>;
  otherMember: ReturnType<typeof createUserSync>;
} {
  const agentOwner = createUserSync({ displayName: "Owner", primaryEmail: "owner@example.com" });
  const requester = createUserSync({ displayName: "Mina", primaryEmail: "mina@example.com" });
  const otherMember = createUserSync({ displayName: "Other", primaryEmail: "other@example.com" });
  const workspace = createWorkspaceSync({
    id: `agent-access-request-service-${Math.random().toString(36).slice(2)}`,
    slug: `agent-access-request-service-${Math.random().toString(36).slice(2)}`,
    name: "Agent Access Request Service",
    createdBy: agentOwner.id,
  });
  createWorkspaceMembershipSync({ workspaceId: workspace.id, userId: agentOwner.id, role: "member" });
  createWorkspaceMembershipSync({ workspaceId: workspace.id, userId: requester.id, role: "member" });
  createWorkspaceMembershipSync({ workspaceId: workspace.id, userId: otherMember.id, role: "member" });
  const state = resetWorkspaceStateSync(workspace.id);
  writeWorkspaceStateSync({
    ...state,
    humanMembers: [
      { name: agentOwner.displayName, role: "Owner" },
      { name: requester.displayName, role: "Member" },
      { name: otherMember.displayName, role: "Member" },
    ],
  }, workspace.id);
  createEmployeeSync({
    name: "Planner",
    role: "Product Agent",
    remarkName: "Product Planner",
    summary: "Plans product work.",
    traits: ["structured"],
    fit: "Product planning",
    instructions: "Plan launches carefully.",
    ownerUserId: agentOwner.id,
  }, workspace.id);

  return {
    workspaceId: workspace.id,
    agentOwner,
    requester,
    otherMember,
  };
}
