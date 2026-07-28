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
  grantRuntimeUseToUserSync,
  listEmployeeRuntimeBindingsSync,
  listWorkspaceNotificationsForRecipientSync,
  readStoredEmployeeSync,
  registerDaemonRuntimesSync,
} from "@dofe-agent/db";
import {
  acceptAgentForkInvitationForActorSync,
  createAgentForkInvitationForActorSync,
  createEmployeeSync,
  createWorkspaceSkillSync,
  listAgentForkInvitationsForActorSync,
  listEmployeeSkillIdsSync,
  listKnowledgeAssignmentsByEmployeeSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  revokeAgentForkInvitationForActorSync,
  setEmployeeKnowledgePageIdsSync,
  setEmployeeSkillIdsSync,
  setKnowledgePageAssignmentModeSync,
  writeWorkspaceStateSync,
} from "../index.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-agent-fork-service-"));
const originalCwd = process.cwd();

before(() => {
  process.env.DOFE_AGENT_REPOSITORY_ROOT = originalCwd;
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  getDatabase().exec(`
    DELETE FROM agent_fork_snapshot;
    DELETE FROM agent_fork_invitation;
    DELETE FROM workspace_notification;
    DELETE FROM employee_runtime_binding;
    DELETE FROM workspace_runtime_grant;
    DELETE FROM agent_runtime;
    DELETE FROM daemon_connection;
    DELETE FROM agent_knowledge_page;
    DELETE FROM knowledge_page_assignment_policy;
    DELETE FROM agent_skill;
    DELETE FROM skill_file;
    DELETE FROM skill;
    DELETE FROM workspace_employee;
    DELETE FROM workspace_snapshot;
    DELETE FROM workspace_membership;
    DELETE FROM workspace;
    DELETE FROM users;
  `);
});

test("agent owner can fork an agent and target accepts with their granted runtime", () => {
  const fixtures = seedForkServiceWorkspace();
  const invitation = createAgentForkInvitationForActorSync({
    workspaceId: fixtures.workspaceId,
    sourceAgentName: "Planner",
    targetUserId: fixtures.target.id,
    actorUserId: fixtures.agentOwner.id,
    options: {
      copyProfile: true,
      copyInstructions: true,
      copySkills: true,
      copyKnowledgeAssignments: true,
      contextNote: "Use this for product planning.",
    },
  });

  assert.equal(invitation.status, "pending");
  assert.deepEqual(invitation.snapshot?.skillIds, [fixtures.skillId]);
  assert.deepEqual(invitation.snapshot?.knowledgePageIds, ["page-prd"]);
  assert.equal(
    listWorkspaceNotificationsForRecipientSync({
      workspaceId: fixtures.workspaceId,
      recipientType: "human",
      recipientId: fixtures.target.id,
    })[0]?.type,
    "agent.fork_invitation_created",
  );

  setEmployeeSkillIdsSync("Planner", [], fixtures.workspaceId);
  const accepted = acceptAgentForkInvitationForActorSync({
    workspaceId: fixtures.workspaceId,
    invitationId: invitation.id,
    actorUserId: fixtures.target.id,
    newAgentName: "Mina Planner",
    runtimeId: fixtures.targetRuntimeId,
  });

  const forkedAgent = readStoredEmployeeSync("Mina Planner", fixtures.workspaceId);
  assert.equal(accepted.agentName, "Mina Planner");
  assert.equal(forkedAgent?.ownerUserId, fixtures.target.id);
  assert.equal(forkedAgent?.channelMemberAccess, "disabled");
  assert.equal(forkedAgent?.origin, `agent-fork:Planner:${invitation.id}`);
  assert.match(forkedAgent?.instructions ?? "", /Plan launches carefully/);
  assert.match(forkedAgent?.instructions ?? "", /Fork context note/);
  assert.deepEqual(listEmployeeSkillIdsSync("Mina Planner", fixtures.workspaceId), [fixtures.skillId]);
  assert.deepEqual(
    listKnowledgeAssignmentsByEmployeeSync("Mina Planner", fixtures.workspaceId).map((assignment) => assignment.knowledgePageId),
    ["page-prd"],
  );
  assert.equal(
    listEmployeeRuntimeBindingsSync(fixtures.workspaceId).find((binding) => binding.employeeName === "Mina Planner")?.runtimeId,
    fixtures.targetRuntimeId,
  );
  assert.equal(
    listEmployeeRuntimeBindingsSync(fixtures.workspaceId).find((binding) => binding.employeeName === "Planner")?.runtimeId,
    fixtures.sourceRuntimeId,
  );

  const state = readWorkspaceStateSync(fixtures.workspaceId);
  const humanDirectChannel = state.channels.find((channel) =>
    channel.kind === "direct" &&
    channel.employeeNames.length === 0 &&
    channel.humanMemberNames?.includes(fixtures.agentOwner.displayName) &&
    channel.humanMemberNames?.includes(fixtures.target.displayName)
  );
  assert.ok(humanDirectChannel);
  const directMessages = state.messages.filter((message) => message.channel === humanDirectChannel.name);
  assert.equal(
    directMessages.some((message) => message.code === "agent.fork_invitation_created"),
    true,
  );
  assert.equal(
    directMessages.some((message) => message.code === "agent.fork_invitation_accepted"),
    true,
  );
  assert.equal(
    state.ledger.some((entry) => entry.code === "agent.fork_invitation_accepted"),
    true,
  );
  assert.equal(
    state.ledger.some((entry) => entry.code === "agent.fork_created"),
    true,
  );
});

test("fork permissions reject non-owners, non-target acceptors, and ungranted runtimes", () => {
  const fixtures = seedForkServiceWorkspace();

  assert.throws(() => createAgentForkInvitationForActorSync({
    workspaceId: fixtures.workspaceId,
    sourceAgentName: "Planner",
    targetUserId: fixtures.target.id,
    actorUserId: fixtures.otherMember.id,
    options: {
      copyProfile: true,
      copyInstructions: true,
      copySkills: true,
      copyKnowledgeAssignments: true,
    },
  }), /workspace owners and admins/);

  const invitation = createAgentForkInvitationForActorSync({
    workspaceId: fixtures.workspaceId,
    sourceAgentName: "Planner",
    targetUserId: fixtures.target.id,
    actorUserId: fixtures.admin.id,
    options: {
      copyProfile: true,
      copyInstructions: true,
      copySkills: true,
      copyKnowledgeAssignments: true,
    },
  });

  assert.throws(() => acceptAgentForkInvitationForActorSync({
    workspaceId: fixtures.workspaceId,
    invitationId: invitation.id,
    actorUserId: fixtures.otherMember.id,
    newAgentName: "Other Planner",
    runtimeId: fixtures.targetRuntimeId,
  }), /user_mismatch/);

  assert.throws(() => acceptAgentForkInvitationForActorSync({
    workspaceId: fixtures.workspaceId,
    invitationId: invitation.id,
    actorUserId: fixtures.target.id,
    newAgentName: "Mina Planner",
    runtimeId: fixtures.sourceRuntimeId,
  }), /runtime|available/);
});

test("creator can revoke a pending fork invitation and target can list only their invitations", () => {
  const fixtures = seedForkServiceWorkspace();
  const invitation = createAgentForkInvitationForActorSync({
    workspaceId: fixtures.workspaceId,
    sourceAgentName: "Planner",
    targetUserId: fixtures.target.id,
    actorUserId: fixtures.agentOwner.id,
    options: {
      copyProfile: true,
      copyInstructions: true,
      copySkills: true,
      copyKnowledgeAssignments: true,
    },
  });

  assert.equal(listAgentForkInvitationsForActorSync({
    workspaceId: fixtures.workspaceId,
    actorUserId: fixtures.target.id,
  }).length, 1);
  assert.equal(listAgentForkInvitationsForActorSync({
    workspaceId: fixtures.workspaceId,
    actorUserId: fixtures.otherMember.id,
  }).length, 0);

  const revoked = revokeAgentForkInvitationForActorSync({
    workspaceId: fixtures.workspaceId,
    invitationId: invitation.id,
    actorUserId: fixtures.agentOwner.id,
  });
  assert.equal(revoked.status, "revoked");
  assert.equal(
    listWorkspaceNotificationsForRecipientSync({
      workspaceId: fixtures.workspaceId,
      recipientType: "human",
      recipientId: fixtures.target.id,
      status: "unread",
    }).some((notification) => notification.type === "agent.fork_invitation_revoked"),
    true,
  );
});

function seedForkServiceWorkspace(): {
  workspaceId: string;
  admin: ReturnType<typeof createUserSync>;
  agentOwner: ReturnType<typeof createUserSync>;
  target: ReturnType<typeof createUserSync>;
  otherMember: ReturnType<typeof createUserSync>;
  skillId: string;
  sourceRuntimeId: string;
  targetRuntimeId: string;
} {
  const admin = createUserSync({ displayName: "Admin", primaryEmail: "admin@example.com" });
  const agentOwner = createUserSync({ displayName: "Owner", primaryEmail: "owner@example.com" });
  const target = createUserSync({ displayName: "Mina", primaryEmail: "mina@example.com" });
  const otherMember = createUserSync({ displayName: "Other", primaryEmail: "other@example.com" });
  const workspace = createWorkspaceSync({
    id: `agent-fork-service-${Math.random().toString(36).slice(2)}`,
    slug: `agent-fork-service-${Math.random().toString(36).slice(2)}`,
    name: "Agent Fork Service",
    createdBy: admin.id,
  });
  createWorkspaceMembershipSync({ workspaceId: workspace.id, userId: admin.id, role: "admin" });
  createWorkspaceMembershipSync({ workspaceId: workspace.id, userId: agentOwner.id, role: "admin" });
  createWorkspaceMembershipSync({ workspaceId: workspace.id, userId: target.id, role: "member" });
  createWorkspaceMembershipSync({ workspaceId: workspace.id, userId: otherMember.id, role: "member" });
  const state = resetWorkspaceStateSync(workspace.id);
  writeWorkspaceStateSync({
    ...state,
    humanMembers: [
      { name: admin.displayName, role: "Admin" },
      { name: agentOwner.displayName, role: "Admin" },
      { name: target.displayName, role: "Member" },
      { name: otherMember.displayName, role: "Member" },
    ],
    knowledgePages: [
      {
        id: "page-prd",
        title: "PRD Playbook",
        content: "Write crisp PRDs.",
        tags: ["product"],
        createdBy: admin.displayName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        assignmentMode: "selected_agents",
      },
    ],
  }, workspace.id);
  const runtimeSnapshot = registerDaemonRuntimesSync({
    workspaceId: workspace.id,
    daemonKey: `daemon-${workspace.id}`,
    deviceName: "Test machine",
    runtimes: [
      { provider: "codex", name: "Source runtime" },
    ],
  });
  const sourceRuntimeId = runtimeSnapshot.runtimes.find((runtime) => runtime.provider === "codex")!.id;
  const targetSnapshot = registerDaemonRuntimesSync({
    workspaceId: workspace.id,
    daemonKey: `daemon-target-${workspace.id}`,
    deviceName: "Target machine",
    runtimes: [
      { provider: "claude", name: "Target runtime" },
    ],
  });
  const targetRuntimeId = targetSnapshot.runtimes.find((runtime) => runtime.provider === "claude")!.id;
  grantRuntimeUseToUserSync({
    workspaceId: workspace.id,
    runtimeId: targetRuntimeId,
    userId: target.id,
    grantedByUserId: admin.id,
  });
  const skill = createWorkspaceSkillSync({
    name: "Docs",
    description: "Document work",
    content: "# Docs\n",
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
    skillIds: [skill.id],
  }, workspace.id);
  setEmployeeSkillIdsSync("Planner", [skill.id], workspace.id);
  setKnowledgePageAssignmentModeSync("page-prd", "selected_agents", admin.displayName, workspace.id);
  setEmployeeKnowledgePageIdsSync("Planner", ["page-prd"], admin.displayName, workspace.id);
  const now = new Date().toISOString();
  listEmployeeRuntimeBindingsSync(workspace.id);
  getDatabase().prepare(
    `INSERT INTO employee_runtime_binding (workspace_id, employee_name, runtime_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(workspace.id, "Planner", sourceRuntimeId, now, now);

  return {
    workspaceId: workspace.id,
    admin,
    agentOwner,
    target,
    otherMember,
    skillId: skill.id,
    sourceRuntimeId,
    targetRuntimeId,
  };
}
