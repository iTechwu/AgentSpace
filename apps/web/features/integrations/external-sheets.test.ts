import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAgentDocumentPermissionError,
  mockAssertAgentDocumentActionAllowedSync,
  mockGetWorkspaceDataDirPath,
  mockReadActiveAgentGoogleWorkspaceDelegationSync,
  mockReadChannelDocumentSync,
  mockReadUserSync,
  mockRecordExternalSheetOperationRunSync,
  mockSameValue,
} = vi.hoisted(() => ({
  mockAgentDocumentPermissionError: class AgentDocumentPermissionError extends Error {},
  mockAssertAgentDocumentActionAllowedSync: vi.fn(),
  mockGetWorkspaceDataDirPath: vi.fn(),
  mockReadActiveAgentGoogleWorkspaceDelegationSync: vi.fn(),
  mockReadChannelDocumentSync: vi.fn(),
  mockReadUserSync: vi.fn(),
  mockRecordExternalSheetOperationRunSync: vi.fn(),
  mockSameValue: vi.fn((left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase()),
}));

vi.mock("@dofe-agent/db", () => ({
  getWorkspaceDataDirPath: mockGetWorkspaceDataDirPath,
  readActiveAgentGoogleWorkspaceDelegationSync: mockReadActiveAgentGoogleWorkspaceDelegationSync,
  readUserSync: mockReadUserSync,
}));

vi.mock("@dofe-agent/services", () => ({
  AgentDocumentPermissionError: mockAgentDocumentPermissionError,
  assertAgentDocumentActionAllowedSync: mockAssertAgentDocumentActionAllowedSync,
  readChannelDocumentSync: mockReadChannelDocumentSync,
  recordExternalSheetOperationRunSync: mockRecordExternalSheetOperationRunSync,
  sameValue: mockSameValue,
}));

import { applyExternalSheetOperations } from "./external-sheets";

describe("external sheet result manifest ingestion", () => {
  let workspaceDataDir: string;

  beforeEach(() => {
    workspaceDataDir = mkdtempSync(join(tmpdir(), "dofe-agent-workspace-data-"));
    mockGetWorkspaceDataDirPath.mockReset();
    mockAssertAgentDocumentActionAllowedSync.mockReset();
    mockReadActiveAgentGoogleWorkspaceDelegationSync.mockReset();
    mockReadChannelDocumentSync.mockReset();
    mockReadUserSync.mockReset();
    mockRecordExternalSheetOperationRunSync.mockReset();
    mockSameValue.mockClear();

    mockGetWorkspaceDataDirPath.mockReturnValue(workspaceDataDir);
    mockReadChannelDocumentSync.mockReturnValue({
      document: {
        id: "doc-sheet-1",
        title: "Competitors",
        channelName: "research",
        kind: "sheet",
        storageMode: "external",
        externalProvider: "google_workspace",
        externalFileId: "google-file-1",
      },
    });
    mockRecordExternalSheetOperationRunSync.mockImplementation((input: { status: "succeeded" | "failed"; operationType: string; resultPreview?: unknown }) => ({
      id: "external-run-1",
      status: input.status,
      operationType: input.operationType,
      resultPreview: input.resultPreview,
    }));
    mockReadActiveAgentGoogleWorkspaceDelegationSync.mockReturnValue({
      id: "delegation-1",
      userId: "user-1",
      googleEmail: "owner@example.com",
    });
    mockReadUserSync.mockReturnValue({
      displayName: "Owner",
    });
  });

  it("records Agent-executed sheets results without invoking server-side gws", async () => {
    const workDir = writeResultManifest({
      results: [
        {
          documentId: "doc-sheet-1",
          operation: "read",
          range: "Research!A1:C3",
          resultPath: "runtime-output/artifacts/sheets/read-1.json",
          summary: "Read 3 rows and 9 cells.",
          requestSummary: "Read competitor rows.",
          rowCount: 3,
          cellCount: 9,
          headers: ["Name", "Status", "Owner"],
          rowsPreview: [["Name", "Status", "Owner"], ["Acme", "Open", "Vega"]],
          truncated: false,
        },
      ],
    }, {
      values: [
        ["Name", "Status", "Owner"],
        ["Acme", "Open", "Vega"],
        ["Globex", "Done", "Nova"],
      ],
    });

    const result = await applyExternalSheetOperations({
      workDir,
      workspaceId: "workspace-1",
      actorId: "Atlas",
      credentialSource: { type: "agent_delegation", employeeName: "Atlas" },
      channelName: "research",
      taskId: "task-1",
    });

    expect(result.warnings).toEqual([]);
    expect(result.operations[0]).toMatchObject({
      runId: "external-run-1",
      documentId: "doc-sheet-1",
      operationType: "read",
      status: "succeeded",
      resultPath: "runtime-output/artifacts/sheets/read-1.json",
    });
    expect(mockRecordExternalSheetOperationRunSync).toHaveBeenCalledWith({
      channelDocumentId: "doc-sheet-1",
      actorType: "agent",
      actorId: "Atlas",
      delegatedUserId: "user-1",
      delegatedUserDisplayName: "Owner",
      delegatedGoogleEmail: "owner@example.com",
      credentialDelegationId: "delegation-1",
      status: "succeeded",
      intent: "Read competitor rows.",
      operationType: "read",
      rangeA1: "Research!A1:C3",
      affectedRows: 3,
      affectedCells: 9,
      requestSummary: "Read competitor rows.",
      responseSummary: "Read 3 rows and 9 cells.",
      resultArtifactPath: expect.stringContaining("external-sheet-results/task-1/01-read-1.json"),
      resultArtifactFileName: "read-1.json",
      resultArtifactMediaType: "application/json",
      resultArtifactSizeBytes: expect.any(Number),
      resultPreview: {
        rowCount: 3,
        cellCount: 9,
        headers: ["Name", "Status", "Owner"],
        rowsPreview: [["Name", "Status", "Owner"], ["Acme", "Open", "Vega"]],
        truncated: false,
      },
      errorCode: undefined,
      errorMessage: undefined,
      startedAt: undefined,
      finishedAt: expect.any(String),
    }, "workspace-1");
    const storedPath = mockRecordExternalSheetOperationRunSync.mock.calls[0]?.[0].resultArtifactPath as string;
    expect(existsSync(storedPath)).toBe(true);
    expect(JSON.parse(readFileSync(storedPath, "utf8"))).toMatchObject({ values: expect.any(Array) });

    rmSync(workDir, { recursive: true, force: true });
    rmSync(workspaceDataDir, { recursive: true, force: true });
  });

  it("does not execute legacy external-sheets manifests on the server", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-external-sheets-"));
    mkdirSync(join(workDir, "runtime-output"), { recursive: true });
    writeFileSync(
      join(workDir, "runtime-output", "external-sheets.json"),
      JSON.stringify({ operations: [{ documentId: "doc-sheet-1", operationType: "read", intent: "Read", rangeA1: "A1:B2" }] }),
      "utf8",
    );

    const result = await applyExternalSheetOperations({
      workDir,
      workspaceId: "workspace-1",
      actorId: "Atlas",
      credentialSource: { type: "agent_delegation", employeeName: "Atlas" },
      channelName: "research",
    });

    expect(result.operations).toEqual([]);
    expect(result.warnings[0]).toMatch(/已弃用/);
    expect(mockRecordExternalSheetOperationRunSync).not.toHaveBeenCalled();

    rmSync(workDir, { recursive: true, force: true });
    rmSync(workspaceDataDir, { recursive: true, force: true });
  });

  it("rejects result ingestion when the agent has no active delegation", async () => {
    const workDir = writeResultManifest({
      results: [
        {
          documentId: "doc-sheet-1",
          operation: "read",
          range: "Research!A1:C3",
          resultPath: "runtime-output/artifacts/sheets/read-1.json",
          summary: "Read rows.",
        },
      ],
    }, { values: [["Name"]] });
    mockReadActiveAgentGoogleWorkspaceDelegationSync.mockReturnValue(null);

    const result = await applyExternalSheetOperations({
      workDir,
      workspaceId: "workspace-1",
      actorId: "Atlas",
      credentialSource: { type: "agent_delegation", employeeName: "Atlas" },
      channelName: "research",
    });

    expect(result.operations[0]?.status).toBe("failed");
    expect(result.warnings[0]).toMatch(/agent_not_delegated/);
    expect(mockRecordExternalSheetOperationRunSync).not.toHaveBeenCalled();

    rmSync(workDir, { recursive: true, force: true });
    rmSync(workspaceDataDir, { recursive: true, force: true });
  });

  it("rejects write result ingestion when document permissions allow only viewer access", async () => {
    const workDir = writeResultManifest({
      results: [
        {
          documentId: "doc-sheet-1",
          operation: "append_rows",
          range: "Research!A2:C2",
          resultPath: "runtime-output/artifacts/sheets/read-1.json",
          summary: "Appended one row.",
        },
      ],
    }, { updates: { updatedRows: 1 } });
    mockAssertAgentDocumentActionAllowedSync.mockImplementationOnce(() => {
      throw new mockAgentDocumentPermissionError("provider.document_edit_denied");
    });

    await expect(applyExternalSheetOperations({
      workDir,
      workspaceId: "workspace-1",
      actorId: "Atlas",
      credentialSource: { type: "agent_delegation", employeeName: "Atlas" },
      channelName: "research",
    })).rejects.toThrow(/provider\.document_edit_denied/);

    expect(mockAssertAgentDocumentActionAllowedSync).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      agentName: "Atlas",
      action: "edit",
      documentId: "doc-sheet-1",
      channelName: "research",
    });
    expect(mockRecordExternalSheetOperationRunSync).not.toHaveBeenCalled();

    rmSync(workDir, { recursive: true, force: true });
    rmSync(workspaceDataDir, { recursive: true, force: true });
  });
});

function writeResultManifest(manifest: unknown, resultJson: unknown): string {
  const workDir = mkdtempSync(join(tmpdir(), "dofe-agent-external-sheets-"));
  const sheetsDir = join(workDir, "runtime-output", "artifacts", "sheets");
  mkdirSync(sheetsDir, { recursive: true });
  writeFileSync(join(workDir, "runtime-output", "external-sheets-results.json"), JSON.stringify(manifest), "utf8");
  writeFileSync(join(sheetsDir, "read-1.json"), JSON.stringify(resultJson), "utf8");
  return workDir;
}
