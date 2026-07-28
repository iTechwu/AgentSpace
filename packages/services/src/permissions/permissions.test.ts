import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  createChannelParticipantSync,
  createDaemonApiTokenSync,
  createExternalIntegrationSync,
  createExternalMessageMappingSync,
  createUserSync,
  createWorkspaceMembershipSync,
  createWorkspaceSync,
  getDatabase,
  grantRuntimeUseToUserSync,
  registerDaemonRuntimesSync,
} from "@dofe-agent/db";
import {
  bindEmployeeRuntimeSync,
  createChannelDocumentSync,
  createDocumentPermissionRequestSync,
  createEmployeeSync,
  createKnowledgePageSync,
  createWorkspaceSkillSync,
  grantDocumentAgentAccessSync,
  getPermissionDiagnosticsSync,
  getWorkspacePermissionCenterSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  setEmployeeKnowledgePageIdsSync,
  setEmployeeSkillIdsSync,
  setKnowledgePageAssignmentModeSync,
  writeWorkspaceStateSync,
} from "../index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-permissions-"));

before(() => {
  process.env.DOFE_AGENT_REPOSITORY_ROOT = originalCwd;
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  getDatabase().exec(`
    DELETE FROM external_message_mapping;
    DELETE FROM external_integration;
    DELETE FROM employee_runtime_binding;
    DELETE FROM workspace_runtime_grant;
    DELETE FROM agent_runtime;
    DELETE FROM daemon_connection;
    DELETE FROM daemon_api_token;
    DELETE FROM agent_knowledge_page;
    DELETE FROM knowledge_page_assignment_policy;
    DELETE FROM agent_skill;
    DELETE FROM skill_file;
    DELETE FROM skill;
    DELETE FROM channel_access_request;
    DELETE FROM channel_invitation;
    DELETE FROM channel_participant;
    DELETE FROM workspace_employee;
    DELETE FROM workspace_channel;
    DELETE FROM workspace_snapshot;
    DELETE FROM workspace_membership;
    DELETE FROM workspace;
    DELETE FROM users;
  `);
});

test("permission center aggregates workspace, channel, agent, runtime, and document grants", () => {
  const fixtures = seedPermissionWorkspace();

  const center = getWorkspacePermissionCenterSync({
    workspaceId: fixtures.workspace.id,
    actor: {
      userId: fixtures.owner.id,
      displayName: fixtures.owner.displayName,
      role: "owner",
    },
  });
  const serialized = JSON.stringify(center);

  assert.match(serialized, /Mars Labs/);
  assert.match(serialized, /general/);
  assert.match(serialized, /Atlas/);
  assert.match(serialized, /Codex runtime/);
  assert.match(serialized, /Trip notes/);
  assert.match(serialized, /Sheets Audit/);
  assert.match(serialized, /Planner playbook/);
  assert.equal(serialized.includes("tokenHash"), false);
  assert.equal(serialized.includes("accessTokenEncrypted"), false);
  assert.equal(serialized.includes("refreshTokenEncrypted"), false);
});

test("permission center exposes Feishu external guest policy and recent guest interactions safely", () => {
  const fixtures = seedPermissionWorkspace();
  const integration = createExternalIntegrationSync({
    workspaceId: fixtures.workspace.id,
    provider: "feishu",
    displayName: "Atlas Feishu Bot",
    transportMode: "websocket_worker",
    agentId: "Atlas",
    appId: "cli_atlas_feishu",
    encryptedCredentialsJson: {
      appSecret: "encrypted-secret",
    },
    configJson: {
      externalGuestPolicy: {
        unboundUserMode: "reply_on_mention",
        guestPermissionProfile: "channel_context_only",
        requireIdentityFor: ["writes", "approvals"],
      },
    },
  });
  createExternalMessageMappingSync({
    workspaceId: fixtures.workspace.id,
    integrationId: integration.id,
    direction: "inbound",
    externalMessageId: "om_guest_secret",
    externalThreadId: "om_thread_secret",
    externalSenderId: "ou_guest_secret",
    externalEventId: "evt_guest_secret",
    metadataJson: {
      provider: "feishu",
      actorType: "external_guest",
      externalChatReference: "chat abc123",
      mappedChannelName: "general",
      agentId: "Atlas",
      externalGuestReference: "guest 93af1c",
      externalGuestPermissionProfile: "channel_context_only",
      externalGuestPolicyDecision: "allow",
      externalGuestPolicyReasonCode: "feishu_external_guest_allowed",
      externalGuestUnboundUserMode: "reply_on_mention",
      dispatchStatus: "sent",
    },
  });

  const center = getWorkspacePermissionCenterSync({
    workspaceId: fixtures.workspace.id,
    actor: {
      userId: fixtures.owner.id,
      displayName: fixtures.owner.displayName,
      role: "owner",
    },
  });
  const serialized = JSON.stringify(center);
  const feishuPolicyNode = flattenPermissionTree(center.tree).find((node) => node.id === `external-guest-policy:${integration.id}`);
  const guestActor = center.actors.find((actor) => actor.subjectType === "external_guest");

  assert.ok(feishuPolicyNode);
  assert.equal(feishuPolicyNode.resourceType, "external_identity_policy");
  assert.match(serialized, /Atlas Feishu Bot guest policy/);
  assert.match(serialized, /unbound users: reply_on_mention; channel_context_only/);
  assert.match(serialized, /Guest interaction · general/);
  assert.ok(guestActor);
  assert.equal(guestActor.status, "external");
  assert.match(JSON.stringify(guestActor), /guest interaction: allow/);
  assert.doesNotMatch(serialized, /ou_guest_secret|om_guest_secret|om_thread_secret|evt_guest_secret/);
});

test("plain members only receive their effective permission subset", () => {
  const fixtures = seedPermissionWorkspace();
  writeWorkspaceStateSync({
    ...readWorkspaceStateSync(fixtures.workspace.id),
    channels: [
      ...readWorkspaceStateSync(fixtures.workspace.id).channels,
      {
        name: "owners-only",
        humanMemberNames: ["Mina"],
        humanMembers: 1,
        employeeNames: [],
      },
    ],
  }, fixtures.workspace.id);

  const center = getWorkspacePermissionCenterSync({
    workspaceId: fixtures.workspace.id,
    actor: {
      userId: fixtures.member.id,
      displayName: fixtures.member.displayName,
      role: "member",
    },
  });
  const serialized = JSON.stringify(center);

  assert.match(serialized, /general/);
  assert.match(serialized, /Atlas/);
  assert.doesNotMatch(serialized, /owners-only/);
  assert.doesNotMatch(serialized, /remote install/);
});

test("permission center separates direct-channel management from content read access", () => {
  const fixtures = seedPermissionWorkspace();
  const state = readWorkspaceStateSync(fixtures.workspace.id);
  writeWorkspaceStateSync({
    ...state,
    channels: [
      ...state.channels,
      {
        name: "direct-alex-atlas",
        kind: "direct",
        humanMemberNames: [fixtures.member.displayName],
        humanMembers: 1,
        employeeNames: ["Atlas"],
      },
    ],
    messages: [
      ...state.messages,
      {
        id: "message-direct-secret",
        channel: "direct-alex-atlas",
        speaker: "Atlas",
        role: "agent",
        time: "2026-05-01T10:00:00.000Z",
        summary: "owner should not read this direct content",
        status: "completed",
        attachments: [
          {
            id: "attachment-direct-secret",
            fileName: "direct-secret.md",
            mediaType: "text/markdown",
            sizeBytes: 12,
            kind: "file",
            storedPath: join(tempRoot, "data", "direct-secret.md"),
          },
        ],
      },
    ],
    channelDocuments: [
      ...state.channelDocuments,
      {
        id: "doc-direct-secret",
        channelName: "direct-alex-atlas",
        title: "Direct Secret",
        slug: "direct-secret",
        kind: "markdown",
        storageMode: "native",
        status: "active",
        currentVersionId: "doc-direct-secret-v1",
        summary: "direct secret",
        lastEditorType: "human",
        createdBy: fixtures.member.displayName,
        updatedBy: fixtures.member.displayName,
        createdAt: "2026-05-01T10:00:00.000Z",
        updatedAt: "2026-05-01T10:00:00.000Z",
      },
    ],
    channelDocumentVersions: [
      ...state.channelDocumentVersions,
      {
        id: "doc-direct-secret-v1",
        documentId: "doc-direct-secret",
        contentMarkdown: "# Direct Secret",
        summary: "direct secret",
        createdBy: fixtures.member.displayName,
        createdByType: "human",
        triggerType: "manual",
        createdAt: "2026-05-01T10:00:00.000Z",
      },
    ],
  }, fixtures.workspace.id);

  const ownerCenter = getWorkspacePermissionCenterSync({
    workspaceId: fixtures.workspace.id,
    actor: {
      userId: fixtures.owner.id,
      displayName: fixtures.owner.displayName,
      role: "owner",
    },
  });
  const ownerNodes = flattenPermissionTree(ownerCenter.tree);
  const directNode = ownerNodes.find((node) => node.id === "channel:direct-alex-atlas");
  assert.ok(directNode);
  assert.ok(directNode.bindings.some((binding) =>
    binding.subjectId === fixtures.owner.id &&
    binding.permission === "manage membership; content private to direct participants"
  ));
  assert.equal(directNode.bindings.some((binding) =>
    binding.subjectId === fixtures.owner.id &&
    binding.permission === "direct content reader"
  ), false);
  assert.equal(ownerNodes.some((node) => node.id === "document:doc-direct-secret"), false);
  assert.equal(ownerNodes.some((node) => node.id === "file:attachment-direct-secret"), false);

  const memberCenter = getWorkspacePermissionCenterSync({
    workspaceId: fixtures.workspace.id,
    actor: {
      userId: fixtures.member.id,
      displayName: fixtures.member.displayName,
      role: "member",
    },
  });
  const memberNodes = flattenPermissionTree(memberCenter.tree);
  assert.ok(memberNodes.some((node) => node.id === "channel:direct-alex-atlas"));
  assert.ok(memberNodes.some((node) => node.id === "file:attachment-direct-secret"));
});

test("permission center exposes document agent grants and requests for review", () => {
  const fixtures = seedPermissionWorkspace();
  const state = readWorkspaceStateSync(fixtures.workspace.id);
  const document = state.channelDocuments.find((item) => item.title === "Trip notes");
  assert.ok(document);
  grantDocumentAgentAccessSync({
    workspaceId: fixtures.workspace.id,
    documentId: document.id,
    agentName: "Atlas",
    role: "forwarder",
    grantedByUserId: fixtures.owner.id,
  });
  createDocumentPermissionRequestSync({
    workspaceId: fixtures.workspace.id,
    documentId: document.id,
    requestedRole: "editor",
    requestedByAgentName: "Atlas",
    requestedForChannelName: "general",
    reason: "Need to keep the shared itinerary updated.",
  });

  const center = getWorkspacePermissionCenterSync({
    workspaceId: fixtures.workspace.id,
    actor: {
      userId: fixtures.owner.id,
      displayName: fixtures.owner.displayName,
      role: "owner",
    },
  });
  const documentNode = flattenPermissionTree(center.tree).find((node) => node.id === `document:${document.id}`);
  assert.ok(documentNode);
  assert.ok(documentNode.bindings.some((binding) =>
    binding.subjectType === "agent" &&
    binding.subjectId === "Atlas" &&
    binding.source === "document_agent_access" &&
    binding.permission === "forwarder" &&
    binding.updateAction === "document_agent_access_role" &&
    binding.revokeAction === "document_agent_access_revoke"
  ));
  assert.ok(documentNode.bindings.some((binding) =>
    binding.subjectType === "agent" &&
    binding.subjectId === "Atlas" &&
    binding.source === "document_permission_request" &&
    binding.permission === "requested editor" &&
    binding.status === "pending" &&
    binding.updateAction === "document_permission_request_approve" &&
    binding.revokeAction === "document_permission_request_reject"
  ));
  assert.ok(center.actors.some((actor) =>
    actor.subjectType === "agent" &&
    actor.subjectId === "Atlas" &&
    actor.permissions.some((permission) =>
      permission.resourceLabel === "Trip notes" &&
      permission.source === "document_agent_access" &&
      permission.permission === "forwarder"
    ) &&
    actor.permissions.some((permission) =>
      permission.resourceLabel === "Trip notes" &&
      permission.source === "document_permission_request" &&
      permission.permission === "requested editor" &&
      permission.status === "pending"
    )
  ));
});

test("workspace owners can review document permission requests", () => {
  const fixtures = seedPermissionWorkspace();
  const state = readWorkspaceStateSync(fixtures.workspace.id);
  const document = state.channelDocuments.find((item) => item.title === "Trip notes");
  assert.ok(document);
  createDocumentPermissionRequestSync({
    workspaceId: fixtures.workspace.id,
    documentId: document.id,
    requestedRole: "viewer",
    requestedByAgentName: "Atlas",
    requestedForChannelName: "general",
    reason: "Need to read the itinerary.",
  });

  const center = getWorkspacePermissionCenterSync({
    workspaceId: fixtures.workspace.id,
    actor: {
      userId: fixtures.owner.id,
      displayName: fixtures.owner.displayName,
      role: "owner",
    },
  });
  const documentNode = flattenPermissionTree(center.tree).find((node) => node.id === `document:${document.id}`);

  assert.ok(documentNode);
  assert.ok(documentNode.bindings.some((binding) =>
    binding.source === "document_permission_request" &&
    binding.permission === "requested viewer" &&
    binding.updateAction === "document_permission_request_approve" &&
    binding.revokeAction === "document_permission_request_reject"
  ));
});

test.after(() => {
  process.chdir(originalCwd);
  delete process.env.DOFE_AGENT_REPOSITORY_ROOT;
  rmSync(tempRoot, { recursive: true, force: true });
});

function seedPermissionWorkspace() {
  const owner = createUserSync({
    displayName: "Mina",
    primaryEmail: "mina@example.com",
  });
  const member = createUserSync({
    displayName: "Alex",
    primaryEmail: "alex@example.com",
  });
  const workspace = createWorkspaceSync({
    name: "Mars Labs",
    createdBy: owner.id,
  });
  createWorkspaceMembershipSync({
    workspaceId: workspace.id,
    userId: owner.id,
    role: "owner",
  });
  createWorkspaceMembershipSync({
    workspaceId: workspace.id,
    userId: member.id,
    role: "member",
  });
  resetWorkspaceStateSync(workspace.id);
  writeWorkspaceStateSync({
    ...readWorkspaceStateSync(workspace.id),
    organizationName: "Mars Labs",
    humanMembers: [
      { name: "Mina", role: "Founder" },
      { name: "Alex", role: "Operator" },
    ],
    channels: [
      {
        name: "general",
        humanMemberNames: ["Mina", "Alex"],
        humanMembers: 2,
        employeeNames: [],
      },
    ],
  }, workspace.id);

  createChannelParticipantSync({
    workspaceId: workspace.id,
    channelName: "general",
    userId: member.id,
    addedBy: owner.id,
  });
  createEmployeeSync({
    name: "Atlas",
    ownerUserId: member.id,
    channelMemberAccess: "enabled",
  }, workspace.id);
  const state = readWorkspaceStateSync(workspace.id);
  state.activeEmployees = state.activeEmployees.map((employee) =>
    employee.name === "Atlas" ? { ...employee, channels: ["general"] } : employee,
  );
  state.channels = state.channels.map((channel) =>
    channel.name === "general" ? { ...channel, employeeNames: ["Atlas"] } : channel,
  );
  writeWorkspaceStateSync(state, workspace.id);

  const skill = createWorkspaceSkillSync({
    name: "Sheets Audit",
    description: "Audit spreadsheet access.",
  }, workspace.id);
  setEmployeeSkillIdsSync("Atlas", [skill.id], workspace.id);
  const knowledgeState = createKnowledgePageSync({
    title: "Planner playbook",
    contentMarkdown: "Use this for planning.",
  }, workspace.id);
  const page = knowledgeState.knowledgePages.find((item) => item.title === "Planner playbook");
  assert.ok(page);
  setKnowledgePageAssignmentModeSync(page.id, "selected_agents", "Mina", workspace.id);
  setEmployeeKnowledgePageIdsSync("Atlas", [page.id], "Mina", workspace.id);

  const runtimeSnapshot = registerDaemonRuntimesSync({
    workspaceId: workspace.id,
    daemonKey: "remote-daemon-key",
    deviceName: "remote install",
    runtimes: [
      {
        provider: "codex",
        name: "Codex runtime",
      },
    ],
  });
  const runtime = runtimeSnapshot.runtimes[0]!;
  grantRuntimeUseToUserSync({
    workspaceId: workspace.id,
    runtimeId: runtime.id,
    userId: member.id,
    grantedByUserId: owner.id,
  });
  bindEmployeeRuntimeSync("Atlas", runtime.id, workspace.id, owner.id);
  createDaemonApiTokenSync({
    workspaceId: workspace.id,
    label: "remote install",
    createdBy: "Mina",
  });

  createChannelDocumentSync({
    channelName: "general",
    title: "Trip notes",
    contentMarkdown: "# Trip notes",
    createdBy: "Mina",
    createdByType: "human",
  }, workspace.id);
  return { workspace, owner, member };
}

function flattenPermissionTree(tree: ReturnType<typeof getWorkspacePermissionCenterSync>["tree"]) {
  const result: Array<ReturnType<typeof getWorkspacePermissionCenterSync>["tree"][number]> = [];
  function visit(node: ReturnType<typeof getWorkspacePermissionCenterSync>["tree"][number]): void {
    result.push(node);
    for (const child of node.children ?? []) {
      visit(child);
    }
  }
  for (const node of tree) {
    visit(node);
  }
  return result;
}
