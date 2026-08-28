import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveAgentAccessRequestSync,
  createAgentForkInvitationSync,
  createAgentAccessRequestSync,
  createUserSync,
  createWorkspaceMembershipSync,
  createWorkspaceSync,
  getDatabase,
  listAgentAccessRequestsSync,
  rejectAgentAccessRequestSync,
} from "./index.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-agent-access-requests-"));
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
    DELETE FROM agent_fork_invitation;
    DELETE FROM workspace_membership;
    DELETE FROM workspace;
    DELETE FROM users;
  `);
});

test("agent access requests are deduped while pending and can be decided", () => {
  const { workspaceId, requesterId, resolverId } = seedAgentAccessRequestDbRecords();

  const created = createAgentAccessRequestSync({
    workspaceId,
    sourceAgentName: "Planner",
    requesterUserId: requesterId,
    requestType: "fork_copy",
    reason: "Need a copy for launches.",
  });
  const duplicate = createAgentAccessRequestSync({
    workspaceId,
    sourceAgentName: "Planner",
    requesterUserId: requesterId,
    requestType: "fork_copy",
    reason: "Need a copy for launches.",
  });

  assert.equal(created.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.request.id, created.request.id);
  assert.equal(listAgentAccessRequestsSync(workspaceId).length, 1);

  const invitation = createAgentForkInvitationSync({
    workspaceId,
    sourceAgentName: "Planner",
    targetUserId: requesterId,
    createdByUserId: resolverId,
    optionsJson: "{}",
    snapshotJson: "{}",
  }).invitation;
  const approved = approveAgentAccessRequestSync({
    workspaceId,
    requestId: created.request.id,
    resolverUserId: resolverId,
    forkInvitationId: invitation.id,
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.forkInvitationId, invitation.id);
  assert.equal(approved.resolverUserId, resolverId);
  assert.ok(approved.resolvedAt);

  const next = createAgentAccessRequestSync({
    workspaceId,
    sourceAgentName: "Planner",
    requesterUserId: requesterId,
    requestType: "fork_copy",
  });
  assert.equal(next.created, true);
  assert.notEqual(next.request.id, created.request.id);

  const rejected = rejectAgentAccessRequestSync({
    workspaceId,
    requestId: next.request.id,
    resolverUserId: resolverId,
  });
  assert.equal(rejected.status, "rejected");
  assert.equal(
    listAgentAccessRequestsSync(workspaceId, { statuses: ["pending"] }).length,
    0,
  );
});

test("channel use access requests preserve their target channel", () => {
  const { workspaceId, requesterId } = seedAgentAccessRequestDbRecords();

  const created = createAgentAccessRequestSync({
    workspaceId,
    sourceAgentName: "Planner",
    requesterUserId: requesterId,
    requestType: "channel_use",
    targetChannelName: "launch",
  });
  const duplicate = createAgentAccessRequestSync({
    workspaceId,
    sourceAgentName: "Planner",
    requesterUserId: requesterId,
    requestType: "channel_use",
    targetChannelName: "launch",
  });
  const otherChannel = createAgentAccessRequestSync({
    workspaceId,
    sourceAgentName: "Planner",
    requesterUserId: requesterId,
    requestType: "channel_use",
    targetChannelName: "research",
  });

  assert.equal(created.request.targetChannelName, "launch");
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.request.id, created.request.id);
  assert.equal(otherChannel.created, true);
  assert.equal(otherChannel.request.targetChannelName, "research");
});

function seedAgentAccessRequestDbRecords(): {
  workspaceId: string;
  requesterId: string;
  resolverId: string;
} {
  const resolver = createUserSync({
    displayName: "Owner",
    primaryEmail: "owner@example.com",
  });
  const requester = createUserSync({
    displayName: "Mina",
    primaryEmail: "mina@example.com",
  });
  const workspace = createWorkspaceSync({
    slug: "agent-access-request-db",
    name: "Agent Access Request DB",
    createdBy: resolver.id,
  });
  createWorkspaceMembershipSync({ workspaceId: workspace.id, userId: resolver.id, role: "owner" });
  createWorkspaceMembershipSync({ workspaceId: workspace.id, userId: requester.id, role: "member" });
  return { workspaceId: workspace.id, requesterId: requester.id, resolverId: resolver.id };
}
