import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before, beforeEach } from "node:test";
import {
  createUserSync,
  createWorkspaceMembershipSync,
  createWorkspaceSync,
} from "@dofe-agent/db";
import {
  addChannelEmployeesSync,
  approveDocumentPermissionRequestSync,
  createChannelDocumentSync,
  createDocumentPermissionRequestSync,
  createEmployeeSync,
  grantDocumentAgentAccessSync,
  initializeOrganizationSync,
  listDocumentAgentAccessSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  resolveAgentDocumentContextSync,
} from "../index.ts";

const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-document-permissions-"));

before(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  resetWorkspaceStateSync();
});

test("resolveAgentDocumentContextSync keeps editor grants scoped to the document channel", { concurrency: false }, () => {
  initializeOrganizationSync({
    organizationName: "Northstar Labs",
    ownerName: "Mina",
    ownerRole: "Owner",
    firstChannelName: "private",
  });
  createEmployeeSync({ name: "Planner" });
  addChannelEmployeesSync({ channelName: "private", employeeNames: ["Planner"] });
  const privateDocument = createChannelDocumentSync({
    channelName: "private",
    title: "Private sheet",
    kind: "sheet",
    storageMode: "external",
    externalProvider: "notion",
    externalFileId: "page-private",
    externalUrl: "https://www.notion.so/page-private",
    contentMarkdown: "sheet",
    createdBy: "Mina",
    createdByType: "human",
  }).document;
  const owner = seedOwnerUser();

  grantDocumentAgentAccessSync({
    workspaceId: "default",
    documentId: privateDocument.id,
    agentName: "Planner",
    role: "editor",
    grantedByUserId: owner.id,
  });

  assert.equal(
    resolveAgentDocumentContextSync({
      workspaceId: "default",
      agentName: "Planner",
      channelName: "private",
    }).some((context) => context.document.id === privateDocument.id && context.role === "editor"),
    true,
  );
  assert.equal(
    resolveAgentDocumentContextSync({
      workspaceId: "default",
      agentName: "Planner",
      channelName: "public",
    }).some((context) => context.document.id === privateDocument.id),
    false,
  );

  grantDocumentAgentAccessSync({
    workspaceId: "default",
    documentId: privateDocument.id,
    agentName: "Planner",
    role: "forwarder",
    grantedByUserId: owner.id,
  });

  assert.equal(
    resolveAgentDocumentContextSync({
      workspaceId: "default",
      agentName: "Planner",
      channelName: "public",
    }).some((context) =>
      context.document.id === privateDocument.id &&
      context.role === "forwarder" &&
      context.source === "forward_grant",
    ),
    true,
  );
});

test("external document requests must be linked before approval", { concurrency: false }, () => {
  const suffix = Math.random().toString(36).slice(2);
  const workspaceId = `workspace-doc-approval-${suffix}`;
  const workspace = createWorkspaceSync({
    id: workspaceId,
    slug: workspaceId,
    name: "Doc Approval",
    createdBy: "system",
  });
  const owner = createUserSync({
    displayName: "Mina",
    primaryEmail: `mina-${suffix}@example.com`,
  });
  createWorkspaceMembershipSync({
    workspaceId: workspace.id,
    userId: owner.id,
    role: "owner",
  });
  initializeOrganizationSync({
    organizationName: "Doc Approval",
    ownerName: "Mina",
    ownerRole: "Owner",
    firstChannelName: "share",
  }, workspace.id);
  createEmployeeSync({ name: "Planner" }, workspace.id);
  addChannelEmployeesSync({ channelName: "share", employeeNames: ["Planner"] }, workspace.id);

  const request = createDocumentPermissionRequestSync({
    workspaceId: workspace.id,
    externalProvider: "notion",
    externalUrl: "https://www.notion.so/page-approval",
    requestedRole: "forwarder",
    requestedByAgentName: "Planner",
    requestedForChannelName: "share",
    reason: "Need to share the sheet with the channel.",
  });
  assert.equal(
    readWorkspaceStateSync(workspace.id).messages.some((message) =>
      message.channel === "share" &&
      message.code === "document_permission.requested" &&
      message.data?.requestId === request.id,
    ),
    true,
  );

  assert.throws(
    () => approveDocumentPermissionRequestSync({
      workspaceId: workspace.id,
      requestId: request.id,
      decidedByUserId: owner.id,
    }),
    /before it is linked to a channel document/,
  );
  const state = readWorkspaceStateSync(workspace.id);
  assert.equal(
    listDocumentAgentAccessSync({
      workspaceId: workspace.id,
      agentName: "Planner",
    }).length,
    0,
  );
  assert.equal(state.channelDocuments.some((document) => document.externalFileId === "page-approval"), false);
});

test("unauthorized users cannot approve external document requests or create side effects", { concurrency: false }, () => {
  const suffix = Math.random().toString(36).slice(2);
  const workspaceId = `workspace-doc-approval-denied-${suffix}`;
  const workspace = createWorkspaceSync({
    id: workspaceId,
    slug: workspaceId,
    name: "Doc Approval Denied",
    createdBy: "system",
  });
  const owner = createUserSync({
    displayName: "Mina",
    primaryEmail: `mina-denied-${suffix}@example.com`,
  });
  const outsider = createUserSync({
    displayName: "Alex",
    primaryEmail: `alex-denied-${suffix}@example.com`,
  });
  createWorkspaceMembershipSync({
    workspaceId: workspace.id,
    userId: owner.id,
    role: "owner",
  });
  createWorkspaceMembershipSync({
    workspaceId: workspace.id,
    userId: outsider.id,
    role: "member",
  });
  initializeOrganizationSync({
    organizationName: "Doc Approval Denied",
    ownerName: "Mina",
    ownerRole: "Owner",
    firstChannelName: "share",
  }, workspace.id);
  createEmployeeSync({ name: "Planner" }, workspace.id);
  addChannelEmployeesSync({ channelName: "share", employeeNames: ["Planner"] }, workspace.id);

  const request = createDocumentPermissionRequestSync({
    workspaceId: workspace.id,
    externalProvider: "notion",
    externalUrl: "https://www.notion.so/page-denied-approval",
    requestedRole: "forwarder",
    requestedByAgentName: "Planner",
    requestedForChannelName: "share",
    reason: "Need to share the sheet with the channel.",
  });

  assert.throws(
    () => approveDocumentPermissionRequestSync({
      workspaceId: workspace.id,
      requestId: request.id,
      decidedByUserId: outsider.id,
    }),
    /Only workspace managers or document owners/,
  );
  const state = readWorkspaceStateSync(workspace.id);
  assert.equal(
    state.channelDocuments.some((document) => document.externalFileId === "page-denied-approval"),
    false,
  );
  assert.equal(
    listDocumentAgentAccessSync({
      workspaceId: workspace.id,
      agentName: "Planner",
    }).length,
    0,
  );
});

function seedOwnerUser() {
  return createUserSync({
    displayName: "Mina",
    primaryEmail: `mina-${Math.random().toString(36).slice(2)}@example.com`,
  });
}
