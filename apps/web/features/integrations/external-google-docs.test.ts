import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAppendGoogleDocText,
  mockAssertAgentDocumentActionAllowedSync,
  mockBatchUpdateGoogleDoc,
  mockGetGoogleWorkspaceAccessTokenForAgent,
  mockGoogleWorkspaceApiError,
  mockReadActiveAgentGoogleWorkspaceDelegationSync,
  mockReadChannelDocumentSync,
  mockReadUserSync,
  mockRecordExternalSheetOperationRunSync,
  mockSameValue,
  mockUpdateExternalChannelDocumentMetadataSync,
  mockUpdateExternalSheetOperationRunSync,
} = vi.hoisted(() => ({
  mockAppendGoogleDocText: vi.fn(),
  mockAssertAgentDocumentActionAllowedSync: vi.fn(),
  mockBatchUpdateGoogleDoc: vi.fn(),
  mockGetGoogleWorkspaceAccessTokenForAgent: vi.fn(),
  mockGoogleWorkspaceApiError: class MockGoogleWorkspaceApiError extends Error {
    status: number;
    code: string;

    constructor(message: string, input: { status: number; code: string }) {
      super(message);
      this.name = "GoogleWorkspaceApiError";
      this.status = input.status;
      this.code = input.code;
    }
  },
  mockReadActiveAgentGoogleWorkspaceDelegationSync: vi.fn(),
  mockReadChannelDocumentSync: vi.fn(),
  mockReadUserSync: vi.fn(),
  mockRecordExternalSheetOperationRunSync: vi.fn(),
  mockSameValue: vi.fn((left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase()),
  mockUpdateExternalChannelDocumentMetadataSync: vi.fn(),
  mockUpdateExternalSheetOperationRunSync: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => ({
  readActiveAgentGoogleWorkspaceDelegationSync: mockReadActiveAgentGoogleWorkspaceDelegationSync,
  readUserSync: mockReadUserSync,
}));

vi.mock("@dofe-agent/services", () => ({
  AgentDocumentPermissionError: class AgentDocumentPermissionError extends Error {},
  assertAgentDocumentActionAllowedSync: mockAssertAgentDocumentActionAllowedSync,
  readChannelDocumentSync: mockReadChannelDocumentSync,
  recordExternalSheetOperationRunSync: mockRecordExternalSheetOperationRunSync,
  sameValue: mockSameValue,
  updateExternalChannelDocumentMetadataSync: mockUpdateExternalChannelDocumentMetadataSync,
  updateExternalSheetOperationRunSync: mockUpdateExternalSheetOperationRunSync,
}));

vi.mock("@/features/integrations/google-workspace", () => ({
  appendGoogleDocText: mockAppendGoogleDocText,
  batchUpdateGoogleDoc: mockBatchUpdateGoogleDoc,
  getGoogleWorkspaceAccessTokenForAgent: mockGetGoogleWorkspaceAccessTokenForAgent,
  getGoogleWorkspaceAccessTokenForUser: vi.fn(),
  GoogleWorkspaceApiError: mockGoogleWorkspaceApiError,
  GOOGLE_DOCS_MIME_TYPE: "application/vnd.google-apps.document",
}));

import { applyExternalGoogleDocOperations } from "./external-google-docs";

describe("external Google Doc operation manifest", () => {
  beforeEach(() => {
    mockAppendGoogleDocText.mockReset();
    mockAssertAgentDocumentActionAllowedSync.mockReset();
    mockBatchUpdateGoogleDoc.mockReset();
    mockGetGoogleWorkspaceAccessTokenForAgent.mockReset();
    mockReadActiveAgentGoogleWorkspaceDelegationSync.mockReset();
    mockReadChannelDocumentSync.mockReset();
    mockReadUserSync.mockReset();
    mockRecordExternalSheetOperationRunSync.mockReset();
    mockSameValue.mockClear();
    mockUpdateExternalChannelDocumentMetadataSync.mockReset();
    mockUpdateExternalSheetOperationRunSync.mockReset();

    mockReadChannelDocumentSync.mockReturnValue({
      document: {
        id: "doc-google-doc-1",
        title: "Meeting Notes",
        channelName: "research",
        kind: "document",
        storageMode: "external",
        externalProvider: "google_workspace",
        externalFileId: "google-doc-1",
        externalMimeType: "application/vnd.google-apps.document",
      },
    });
    mockReadActiveAgentGoogleWorkspaceDelegationSync.mockReturnValue({
      id: "delegation-1",
      userId: "user-1",
      googleEmail: "owner@example.com",
    });
    mockReadUserSync.mockReturnValue({
      displayName: "Owner",
    });
    mockRecordExternalSheetOperationRunSync.mockReturnValue({
      id: "external-run-1",
    });
    mockUpdateExternalSheetOperationRunSync.mockImplementation((input: {
      runId: string;
      status: "succeeded" | "failed";
    }) => ({
      id: input.runId,
      status: input.status,
    }));
    mockGetGoogleWorkspaceAccessTokenForAgent.mockResolvedValue({
      accessToken: "access-token",
    });
    mockAppendGoogleDocText.mockResolvedValue({
      replyCount: 1,
    });
  });

  it("executes append_text operations and records succeeded runs", async () => {
    const workDir = writeManifest([
      {
        documentId: "doc-google-doc-1",
        operationType: "append_text",
        intent: "Append meeting summary",
        text: "\n## Summary\n- Launch approved.",
        textPath: "runtime-output/artifacts/docs/summary.md",
      },
    ]);

    const result = await applyExternalGoogleDocOperations({
      workDir,
      workspaceId: "workspace-1",
      actorId: "Atlas",
      credentialSource: { type: "agent_delegation", employeeName: "Atlas" },
      channelName: "research",
    });

    expect(result.warnings).toEqual([]);
    expect(result.operations).toEqual([
      {
        runId: "external-run-1",
        documentId: "doc-google-doc-1",
        operationType: "append_text",
        status: "succeeded",
        message: "Google Doc 操作成功：Meeting Notes · append_text · Appended text with 1 batch update replies.",
      },
    ]);
    expect(mockAppendGoogleDocText).toHaveBeenCalledWith({
      accessToken: "access-token",
      documentId: "google-doc-1",
      text: "\n## Summary\n- Launch approved.",
    });
    expect(mockAssertAgentDocumentActionAllowedSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      agentName: "Atlas",
      documentId: "doc-google-doc-1",
      channelName: "research",
      action: "edit",
    });
    expect(mockRecordExternalSheetOperationRunSync).toHaveBeenCalledWith({
      channelDocumentId: "doc-google-doc-1",
      actorType: "agent",
      actorId: "Atlas",
      delegatedUserId: "user-1",
      delegatedUserDisplayName: "Owner",
      delegatedGoogleEmail: "owner@example.com",
      credentialDelegationId: "delegation-1",
      status: "running",
      intent: "Append meeting summary",
      operationType: "append_text",
      requestSummary: "append_text 30 character(s).",
    }, "workspace-1");
    expect(mockUpdateExternalSheetOperationRunSync).toHaveBeenCalledWith({
      runId: "external-run-1",
      status: "succeeded",
      affectedRows: 1,
      responseSummary: "Appended text with 1 batch update replies.",
    }, "workspace-1");
  });

  it("marks the external Google Doc missing when gws reports a 404", async () => {
    const workDir = writeManifest([
      {
        documentId: "doc-google-doc-1",
        operationType: "batch_update",
        intent: "Update stale doc",
        requests: [{ insertText: { text: "hello", endOfSegmentLocation: { segmentId: "" } } }],
      },
    ]);
    mockBatchUpdateGoogleDoc.mockRejectedValue(new mockGoogleWorkspaceApiError(
      "Google Docs batch update failed. Requested entity was not found.",
      { status: 404, code: "google_workspace.docs_batch_update_failed" },
    ));

    const result = await applyExternalGoogleDocOperations({
      workDir,
      workspaceId: "workspace-1",
      actorId: "Atlas",
      credentialSource: { type: "agent_delegation", employeeName: "Atlas" },
      channelName: "research",
    });

    expect(result.operations[0]?.status).toBe("failed");
    expect(mockUpdateExternalChannelDocumentMetadataSync).toHaveBeenCalledWith({
      documentId: "doc-google-doc-1",
      externalSyncStatus: "missing",
      updatedBy: "系统提示",
    }, "workspace-1");
    expect(mockUpdateExternalSheetOperationRunSync).toHaveBeenCalledWith({
      runId: "external-run-1",
      status: "failed",
      errorCode: "google_workspace.docs_batch_update_failed",
      errorMessage: "Google Docs batch update failed. Requested entity was not found.",
    }, "workspace-1");
  });

  it("warns when ingesting legacy hand-written operations without CLI artifact provenance", async () => {
    const workDir = writeManifest([
      {
        documentId: "doc-google-doc-1",
        operationType: "append_text",
        intent: "Append legacy summary",
        text: "\n## Summary\n- Legacy path.",
      },
    ]);

    const result = await applyExternalGoogleDocOperations({
      workDir,
      workspaceId: "workspace-1",
      actorId: "Atlas",
      credentialSource: { type: "agent_delegation", employeeName: "Atlas" },
      channelName: "research",
    });

    expect(result.warnings).toEqual([
      "runtime-output/external-google-docs.json legacy hand-written operations are deprecated: Agents must use dofe-agent output google-docs ... instead of editing this JSON directly.",
    ]);
  });
});

function writeManifest(manifest: unknown): string {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-external-google-docs-"));
  mkdirSync(join(workDir, "runtime-output"), { recursive: true });
  writeFileSync(join(workDir, "runtime-output", "external-google-docs.json"), JSON.stringify(manifest), "utf8");
  return workDir;
}
