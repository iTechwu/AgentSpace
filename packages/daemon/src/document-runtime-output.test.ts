import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { beforeEach } from "node:test";
import {
  createUserSync,
  createWorkspaceMembershipSync,
  createWorkspaceSync,
  getDatabase,
  readActiveAgentGoogleWorkspaceDelegationSync,
  upsertAgentGoogleWorkspaceDelegationSync,
  upsertGoogleOAuthCredentialSync,
} from "@dofe-agent/db";
import {
  addChannelEmployeesSync,
  createChannelSync,
  createExternalGoogleSheetChannelDocumentSync,
  createEmployeeSync,
  grantDocumentAgentAccessSync,
  initializeOrganizationSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
} from "@dofe-agent/services";
import {
  appendExternalDocumentCreateGoogleSheetOperation,
  appendExternalDocumentLinkOperation,
} from "./runtime-output-manifests.ts";
import { applyDocumentRuntimeOutputOperations } from "./document-runtime-output.ts";

beforeEach(() => {
  resetWorkspaceStateSync();
  const db = getDatabase();
  db.exec("DELETE FROM agent_google_workspace_delegation");
  db.exec("DELETE FROM google_oauth_credential");
});

test("document runtime output rejects hand-written controlled manifests before service writes", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-document-runtime-output-"));
  try {
    mkdirSync(join(workDir, "runtime-output"), { recursive: true });
    writeFileSync(
      join(workDir, "runtime-output", "permission-requests.json"),
      JSON.stringify({
        version: 1,
        requests: [{
          requestedRole: "forwarder",
          reason: "Need to share it.",
          documentId: "doc-1",
        }],
      }),
      "utf8",
    );
    writeFileSync(
      join(workDir, "runtime-output", "external-documents.json"),
      JSON.stringify({
        version: 1,
        operations: [{
          operationType: "link_google_sheet",
          sourceDocumentId: "doc-1",
          targetChannel: "general",
          title: "Shared Sheet",
        }],
      }),
      "utf8",
    );

    const result = applyDocumentRuntimeOutputOperations({
      workDir,
      workspaceId: "default",
      actorName: "Planner",
      sourceTaskQueueId: "task-1",
    });

    assert.equal(result.permissionRequests.length, 0);
    assert.equal(result.externalDocumentLinks.length, 0);
    assert.ok(result.warnings.some((warning) => warning.includes("permission-requests.json 已被拒绝")));
    assert.ok(result.warnings.some((warning) => warning.includes("external-documents.json 已被拒绝")));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("document runtime output forwards external Google Sheets only with forwarder access", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-document-runtime-output-"));
  try {
    const owner = seedForwardingWorkspace();
    const sourceDocument = createExternalGoogleSheetChannelDocumentSync({
      channelName: "private",
      title: "Private Sheet",
      externalFileId: "sheet-forward",
      externalUrl: "https://docs.google.com/spreadsheets/d/sheet-forward/edit",
      createdBy: "Mina",
      createdByType: "human",
    }).document;
    grantDocumentAgentAccessSync({
      workspaceId: "default",
      documentId: sourceDocument.id,
      agentName: "Planner",
      role: "forwarder",
      grantedByUserId: owner.id,
    });
    appendExternalDocumentLinkOperation(workDir, {
      operationType: "link_google_sheet",
      sourceDocumentId: sourceDocument.id,
      targetChannel: "share",
      title: "Shared Sheet",
    });

    const result = applyDocumentRuntimeOutputOperations({
      workDir,
      workspaceId: "default",
      actorName: "Planner",
      sourceTaskQueueId: "task-1",
      sourceChannelName: "share",
      requestedByUserId: owner.id,
      requestedByDisplayName: "Mina",
    });

    assert.deepEqual(result.warnings, []);
    assert.equal(result.externalDocumentLinks[0]?.status, "succeeded");
    assert.equal(
      readWorkspaceStateSync().channelDocuments.some((document) =>
        document.channelName === "share" &&
        document.externalFileId === "sheet-forward" &&
        document.title === "Shared Sheet",
      ),
      true,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("document runtime output fails forged forwarding without forwarder access", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-document-runtime-output-"));
  try {
    const owner = seedForwardingWorkspace();
    const sourceDocument = createExternalGoogleSheetChannelDocumentSync({
      channelName: "private",
      title: "Private Sheet",
      externalFileId: "sheet-denied",
      externalUrl: "https://docs.google.com/spreadsheets/d/sheet-denied/edit",
      createdBy: "Mina",
      createdByType: "human",
    }).document;
    grantDocumentAgentAccessSync({
      workspaceId: "default",
      documentId: sourceDocument.id,
      agentName: "Planner",
      role: "editor",
      grantedByUserId: owner.id,
    });
    appendExternalDocumentLinkOperation(workDir, {
      operationType: "link_google_sheet",
      sourceDocumentId: sourceDocument.id,
      targetChannel: "share",
      title: "Denied Sheet",
    });

    assert.throws(
      () => applyDocumentRuntimeOutputOperations({
        workDir,
        workspaceId: "default",
        actorName: "Planner",
        sourceTaskQueueId: "task-1",
        sourceChannelName: "share",
        requestedByUserId: owner.id,
        requestedByDisplayName: "Mina",
      }),
      /provider\.document_forward_denied/,
    );
    assert.equal(
      readWorkspaceStateSync().channelDocuments.some((document) =>
        document.channelName === "share" &&
        document.externalFileId === "sheet-denied",
      ),
      false,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("document runtime output creates agent Google Sheet channel documents", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-document-runtime-output-"));
  try {
    const owner = seedForwardingWorkspace();
    mkdirSync(join(workDir, "runtime-output", "artifacts", "sheets"), { recursive: true });
    writeFileSync(
      join(workDir, "runtime-output", "artifacts", "sheets", "create-sheet.json"),
      JSON.stringify({
        id: "sheet-created",
        webViewLink: "https://docs.google.com/spreadsheets/d/sheet-created/edit",
        mimeType: "application/vnd.google-apps.spreadsheet",
        modifiedTime: "2026-05-20T00:00:00.000Z",
      }),
      "utf8",
    );
    appendExternalDocumentCreateGoogleSheetOperation(workDir, {
      operationType: "create_google_sheet",
      externalFileId: "sheet-created",
      externalUrl: "https://docs.google.com/spreadsheets/d/sheet-created/edit",
      targetChannel: "share",
      title: "Created Sheet",
      summary: "Created by agent.",
      resultPath: "runtime-output/artifacts/sheets/create-sheet.json",
    });

    const result = applyDocumentRuntimeOutputOperations({
      workDir,
      workspaceId: "default",
      actorName: "Planner",
      sourceTaskQueueId: "task-create",
      sourceChannelName: "share",
      requestedByUserId: owner.id,
      requestedByDisplayName: "Mina",
    });

    assert.deepEqual(result.warnings, []);
    assert.equal(result.externalDocumentLinks[0]?.operationType, "create_google_sheet");
    assert.equal(result.externalDocumentLinks[0]?.status, "succeeded");
    assert.match(result.statusMessages[0] ?? "", /Google Sheet 已创建并添加到 share/);

    const state = readWorkspaceStateSync();
    const document = state.channelDocuments.find((item) => item.externalFileId === "sheet-created");
    assert.equal(document?.channelName, "share");
    assert.equal(document?.title, "Created Sheet");
    assert.equal(document?.createdBy, "Planner");
    assert.equal(document?.lastEditorType, "agent");
    assert.equal(document?.externalMimeType, "application/vnd.google-apps.spreadsheet");
    assert.equal(document?.externalSyncStatus, "ok");
    const run = state.externalSheetOperationRuns.find((item) => item.channelDocumentId === document?.id && item.operationType === "create");
    assert.equal(run?.status, "succeeded");
    assert.equal(run?.delegatedGoogleEmail, "mina@example.com");
    assert.equal(run?.resultArtifactPath?.includes("external-sheet-results"), true);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("document runtime output fails duplicate created Google Sheet bindings", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-document-runtime-output-"));
  try {
    seedForwardingWorkspace();
    createExternalGoogleSheetChannelDocumentSync({
      channelName: "share",
      title: "Existing Sheet",
      externalFileId: "sheet-created",
      externalUrl: "https://docs.google.com/spreadsheets/d/sheet-created/edit",
      createdBy: "Mina",
      createdByType: "human",
    });
    mkdirSync(join(workDir, "runtime-output", "artifacts", "sheets"), { recursive: true });
    writeFileSync(
      join(workDir, "runtime-output", "artifacts", "sheets", "create-sheet.json"),
      JSON.stringify({
        id: "sheet-created",
        webViewLink: "https://docs.google.com/spreadsheets/d/sheet-created/edit",
        mimeType: "application/vnd.google-apps.spreadsheet",
      }),
      "utf8",
    );
    appendExternalDocumentCreateGoogleSheetOperation(workDir, {
      operationType: "create_google_sheet",
      externalFileId: "sheet-created",
      externalUrl: "https://docs.google.com/spreadsheets/d/sheet-created/edit",
      targetChannel: "share",
      title: "Created Sheet",
      resultPath: "runtime-output/artifacts/sheets/create-sheet.json",
    });

    const result = applyDocumentRuntimeOutputOperations({
      workDir,
      workspaceId: "default",
      actorName: "Planner",
      sourceTaskQueueId: "task-create",
      sourceChannelName: "share",
    });

    assert.equal(result.externalDocumentLinks[0]?.status, "failed");
    assert.match(result.warnings[0] ?? "", /already linked/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("document runtime output requires Google Workspace delegation for created Sheets", () => {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-document-runtime-output-"));
  try {
    seedForwardingWorkspace({ delegate: false });
    mkdirSync(join(workDir, "runtime-output", "artifacts", "sheets"), { recursive: true });
    writeFileSync(
      join(workDir, "runtime-output", "artifacts", "sheets", "create-sheet.json"),
      JSON.stringify({
        id: "sheet-created",
        webViewLink: "https://docs.google.com/spreadsheets/d/sheet-created/edit",
        mimeType: "application/vnd.google-apps.spreadsheet",
      }),
      "utf8",
    );
    appendExternalDocumentCreateGoogleSheetOperation(workDir, {
      operationType: "create_google_sheet",
      externalFileId: "sheet-created",
      externalUrl: "https://docs.google.com/spreadsheets/d/sheet-created/edit",
      targetChannel: "share",
      title: "Created Sheet",
      resultPath: "runtime-output/artifacts/sheets/create-sheet.json",
    });

    assert.throws(
      () => applyDocumentRuntimeOutputOperations({
        workDir,
        workspaceId: "default",
        actorName: "Planner",
        sourceTaskQueueId: "task-create",
        sourceChannelName: "share",
      }),
      /provider\.document_external_auth_unavailable/,
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

function seedForwardingWorkspace(input: { delegate?: boolean } = {}) {
  const owner = createUserSync({
    displayName: "Mina",
    primaryEmail: `mina-${Math.random().toString(36).slice(2)}@example.com`,
  });
  createWorkspaceMembershipSync({
    workspaceId: "default",
    userId: owner.id,
    role: "owner",
  });
  initializeOrganizationSync({
    organizationName: "Northstar Labs",
    ownerName: "Mina",
    ownerRole: "Owner",
    firstChannelName: "private",
  });
  createChannelSync({
    name: "share",
    kind: "group",
    humanMemberNames: ["Mina"],
    employeeNames: [],
  });
  createEmployeeSync({ name: "Planner" });
  addChannelEmployeesSync({ channelName: "private", employeeNames: ["Planner"] });
  addChannelEmployeesSync({ channelName: "share", employeeNames: ["Planner"] });
  const credential = upsertGoogleOAuthCredentialSync({
    workspaceId: "default",
    userId: owner.id,
    googleEmail: "mina@example.com",
    scopes: "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets",
    accessTokenEncrypted: "access-token",
    refreshTokenEncrypted: "refresh-token",
  });
  if (input.delegate !== false) {
    upsertAgentGoogleWorkspaceDelegationSync({
      workspaceId: "default",
      employeeName: "Planner",
      userId: owner.id,
      googleOAuthCredentialId: credential.id,
      scopes: credential.scopes,
      googleEmail: credential.googleEmail,
      grantedByUserId: owner.id,
    });
  }
  assert.ok(readActiveAgentGoogleWorkspaceDelegationSync({
    workspaceId: "default",
    employeeName: "Planner",
  }) || input.delegate === false);
  return owner;
}
