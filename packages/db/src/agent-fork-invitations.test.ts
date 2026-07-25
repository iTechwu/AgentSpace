import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptAgentForkInvitationSync,
  createAgentForkInvitationSync,
  createUserSync,
  createWorkspaceMembershipSync,
  createWorkspaceSync,
  getDatabase,
  listAgentForkInvitationsSync,
  readAgentForkSnapshotByInvitationSync,
  revokeAgentForkInvitationSync,
} from "./index.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-agent-forks-"));
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
    DELETE FROM workspace_membership;
    DELETE FROM workspace;
    DELETE FROM users;
  `);
});

test("agent fork invitations can be created, deduped, accepted, and revoked", () => {
  const { workspaceId, ownerId, targetId } = seedForkDbRecords();

  const created = createAgentForkInvitationSync({
    workspaceId,
    sourceAgentName: "Planner",
    targetUserId: targetId,
    createdByUserId: ownerId,
    optionsJson: JSON.stringify({ copyProfile: true }),
    snapshotJson: JSON.stringify({ skillIds: ["skill-docs"], knowledgePageIds: ["page-prd"] }),
  });
  const duplicate = createAgentForkInvitationSync({
    workspaceId,
    sourceAgentName: "Planner",
    targetUserId: targetId,
    createdByUserId: ownerId,
    optionsJson: JSON.stringify({ copyProfile: true }),
    snapshotJson: JSON.stringify({ skillIds: ["skill-docs"], knowledgePageIds: ["page-prd"] }),
  });

  assert.equal(created.invitation.status, "pending");
  assert.equal(duplicate.invitation.id, created.invitation.id);
  assert.equal(listAgentForkInvitationsSync(workspaceId).length, 1);
  assert.equal(
    readAgentForkSnapshotByInvitationSync(workspaceId, created.invitation.id)?.invitationId,
    created.invitation.id,
  );

  const accepted = acceptAgentForkInvitationSync({
    workspaceId,
    invitationId: created.invitation.id,
    acceptedAgentName: "Mina Planner",
    acceptedRuntimeId: "runtime-codex",
  });
  assert.equal(accepted?.status, "accepted");
  assert.equal(accepted?.acceptedAgentName, "Mina Planner");
  assert.equal(accepted?.acceptedRuntimeId, "runtime-codex");
  assert.equal(listAgentForkInvitationsSync(workspaceId).length, 0);

  const second = createAgentForkInvitationSync({
    workspaceId,
    sourceAgentName: "Planner",
    targetUserId: targetId,
    createdByUserId: ownerId,
    optionsJson: "{}",
    snapshotJson: "{}",
  });
  const revoked = revokeAgentForkInvitationSync({
    workspaceId,
    invitationId: second.invitation.id,
  });
  assert.equal(revoked?.status, "revoked");
  assert.equal(listAgentForkInvitationsSync(workspaceId, { statuses: ["revoked"] })[0]?.id, second.invitation.id);
});

function seedForkDbRecords(): { workspaceId: string; ownerId: string; targetId: string } {
  const owner = createUserSync({
    displayName: "Owner",
    primaryEmail: "owner@example.com",
  });
  const target = createUserSync({
    displayName: "Mina",
    primaryEmail: "mina@example.com",
  });
  const workspace = createWorkspaceSync({
    slug: "agent-fork-db",
    name: "Agent Fork DB",
    createdBy: owner.id,
  });
  createWorkspaceMembershipSync({ workspaceId: workspace.id, userId: owner.id, role: "owner" });
  createWorkspaceMembershipSync({ workspaceId: workspace.id, userId: target.id, role: "member" });
  return { workspaceId: workspace.id, ownerId: owner.id, targetId: target.id };
}
