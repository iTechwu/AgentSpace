import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceSync, getDatabase } from "@dofe-agent/db";
import {
  initializeOrganizationSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  setAttachmentStorageClientForTests,
  writeWorkspaceStateSync,
} from "@dofe-agent/services";
import { createTestTosAttachmentStorage } from "@/test-utils/tos-attachment-storage";
const { mockGetCurrentWorkspaceContext } = vi.hoisted(() => ({
  mockGetCurrentWorkspaceContext: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({
  getCurrentWorkspaceContext: mockGetCurrentWorkspaceContext,
}));

import { GET } from "./route";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-attachments-route-"));
const testTos = createTestTosAttachmentStorage();

beforeAll(() => {
  setAttachmentStorageClientForTests(testTos.client);
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data", "workspaces", "default", "attachments"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  testTos.clear();
  mockGetCurrentWorkspaceContext.mockReset();
  mockGetCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext());
  ensureTestWorkspace("default", "Northstar Labs");
  ensureTestWorkspace("workspace-mars", "Mars Labs");
  resetWorkspaceStateSync();
  initializeOrganizationSync({
    organizationName: "Northstar Labs",
    ownerName: "techwu",
    ownerRole: "Founder",
    firstChannelName: "tour visit",
  });

  const imageStorageKey = "workspaces/default/attachments/att-image/preview.png";
  const fileStorageKey = "workspaces/default/attachments/att-file/summary.pdf";
  const unicodeStorageKey = "workspaces/default/attachments/att-file-unicode/note.md";
  const orphanKnowledgeStorageKey = "workspaces/default/attachments/att-orphan-knowledge/orphan-note.md";
  const imageStoredPath = `tos://test-bucket/${imageStorageKey}`;
  const fileStoredPath = `tos://test-bucket/${fileStorageKey}`;
  const unicodeStoredPath = `tos://test-bucket/${unicodeStorageKey}`;
  const orphanKnowledgeStoredPath = `tos://test-bucket/${orphanKnowledgeStorageKey}`;
  testTos.seed(imageStorageKey, "image-bytes");
  testTos.seed(fileStorageKey, "pdf-bytes");
  testTos.seed(unicodeStorageKey, "unicode-bytes");
  testTos.seed(orphanKnowledgeStorageKey, "orphan-knowledge-bytes");

  writeWorkspaceStateSync({
    ...readWorkspaceStateSync(),
    organizationName: "Northstar Labs",
    pendingHandoffs: 0,
    humanMembers: [
      { name: "techwu", role: "Founder" },
      { name: "Mina", role: "Operator" },
    ],
    activeEmployees: [
      {
        name: "Atlas",
        role: "Planner",
        remarkName: "Atlas",
        origin: "manual",
        summary: "Planner",
        traits: [],
        fit: "Ready",
        skillIds: [],
        channels: [],
        status: "active",
      },
    ],
    channels: [
      {
        name: "tour visit",
        humanMemberNames: ["techwu"],
        humanMembers: 1,
        employeeNames: [],
      },
      {
        name: "direct-atlas",
        kind: "direct",
        humanMemberNames: ["techwu"],
        humanMembers: 1,
        employeeNames: ["Atlas"],
      },
      {
        name: "direct-secret",
        kind: "direct",
        humanMemberNames: ["Mina"],
        humanMembers: 1,
        employeeNames: ["Atlas"],
      },
    ],
    channelDocuments: [],
    channelDocumentVersions: [],
    channelDocumentBlocks: [],
    channelDocumentAccesses: [],
    channelDocumentChangeSets: [],
    channelDocumentConflicts: [],
    channelDocumentPresences: [],
    channelDocumentRuns: [],
    channelDocumentRunSteps: [],
    materials: [],
    knowledgePages: [
      {
        id: "page-orphan-knowledge",
        parentId: null,
        title: "Orphan note",
        contentMarkdown: "# Orphan note",
        sortOrder: 0,
        tags: [],
        createdBy: "techwu",
        createdAt: "2026-04-22T10:00:00.000Z",
        updatedAt: "2026-04-22T10:00:00.000Z",
        sourceAttachmentId: "att-orphan-knowledge",
        sourceAttachmentStoredPath: orphanKnowledgeStoredPath,
      },
      {
        id: "page-hidden-knowledge",
        parentId: null,
        title: "Hidden note",
        contentMarkdown: "# Hidden note",
        sortOrder: 1,
        tags: [],
        createdBy: "Mina",
        createdAt: "2026-04-22T10:05:00.000Z",
        updatedAt: "2026-04-22T10:05:00.000Z",
        sourceAttachmentId: "att-hidden",
        sourceAttachmentStoredPath: fileStoredPath,
      },
    ],
    messages: [
      {
        id: "message-1",
        channel: "tour visit",
        speaker: "Atlas",
        role: "agent",
        time: "10:00",
        summary: "请查看图片。",
        status: "completed",
        attachments: [
          {
            id: "att-image",
            fileName: "nested/preview.png",
            mediaType: "image/png",
            sizeBytes: "image-bytes".length,
            kind: "image",
            storedPath: imageStoredPath,
            storageProvider: "tos",
            storageKey: imageStorageKey,
          },
          {
            id: "att-file-unicode",
            fileName: "nested/测试纪要.md",
            mediaType: "text/markdown",
            sizeBytes: "unicode-bytes".length,
            kind: "file",
            storedPath: unicodeStoredPath,
            storageProvider: "tos",
            storageKey: unicodeStorageKey,
          },
        ],
      },
      {
        id: "message-2",
        channel: "direct-atlas",
        speaker: "Atlas",
        role: "agent",
        time: "10:05",
        summary: "请查看 PDF。",
        status: "completed",
        attachments: [
          {
            id: "att-file",
            fileName: "deliverables/summary.pdf",
            mediaType: "application/pdf",
            sizeBytes: "pdf-bytes".length,
            kind: "file",
            storedPath: fileStoredPath,
            storageProvider: "tos",
            storageKey: fileStorageKey,
          },
        ],
      },
      {
        id: "message-3",
        channel: "direct-secret",
        speaker: "Atlas",
        role: "agent",
        time: "10:10",
        summary: "不应被 techwu 看到。",
        status: "completed",
        attachments: [
          {
            id: "att-hidden",
            fileName: "deliverables/hidden.pdf",
            mediaType: "application/pdf",
            sizeBytes: "pdf-bytes".length,
            kind: "file",
            storedPath: fileStoredPath,
            storageProvider: "tos",
            storageKey: fileStorageKey,
          },
        ],
      },
    ],
    tasks: [],
    approvals: [],
    ledger: [],
  }, "default", { skipVersionCheck: true });

  const marsBaseState = resetWorkspaceStateSync("workspace-mars");
  const workspaceSpecificKey = "workspaces/workspace-mars/attachments/att-workspace/scope.txt";
  const workspaceSpecificPath = `tos://test-bucket/${workspaceSpecificKey}`;
  testTos.seed(workspaceSpecificKey, "workspace-bytes");
  writeWorkspaceStateSync(
    {
      ...marsBaseState,
      organizationName: "Mars Labs",
      pendingHandoffs: 0,
      humanMembers: [{ name: "techwu", role: "Founder" }],
      activeEmployees: [],
      channels: [],
      channelDocuments: [],
      channelDocumentVersions: [],
      channelDocumentBlocks: [],
      channelDocumentAccesses: [],
      channelDocumentChangeSets: [],
      channelDocumentConflicts: [],
      channelDocumentPresences: [],
      channelDocumentRuns: [],
      channelDocumentRunSteps: [],
      materials: [],
      messages: [
        {
          id: "message-workspace",
          speaker: "Atlas",
          role: "agent",
          time: "11:00",
          summary: "workspace scoped attachment",
          status: "completed",
          attachments: [
            {
              id: "att-workspace",
              fileName: "reports/workspace.txt",
              mediaType: "text/plain",
              sizeBytes: "workspace-bytes".length,
              kind: "file",
              storedPath: workspaceSpecificPath,
              storageProvider: "tos",
              storageKey: workspaceSpecificKey,
            },
          ],
        },
      ],
      directConversations: [],
      tasks: [],
      approvals: [],
      ledger: [],
    },
    "workspace-mars",
  );
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("attachments route", () => {
  it("rejects attachment access when the user has no current workspace", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValueOnce(null);

    const response = await GET(new Request("http://localhost/api/attachments/att-image"), {
      params: Promise.resolve({ attachmentId: "att-image" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "Unauthorized." });
  });

  it("serves image attachments inline with a basename content-disposition", async () => {
    const response = await GET(new Request("http://localhost/api/attachments/att-image"), {
      params: Promise.resolve({ attachmentId: "att-image" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="preview.png"');
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600, stale-while-revalidate=86400");
    expect(response.headers.get("ETag")).toBe(buildSha256EntityTag("image-bytes"));
    expect(response.headers.get("Vary")).toBe("Cookie, Authorization");
    expect(await response.text()).toBe("image-bytes");
  });

  it("returns a 304 for authorized image attachments when the entity tag still matches", async () => {
    const response = await GET(
      new Request("http://localhost/api/attachments/att-image", {
        headers: {
          "If-None-Match": buildSha256EntityTag("image-bytes"),
        },
      }),
      {
        params: Promise.resolve({ attachmentId: "att-image" }),
      },
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600, stale-while-revalidate=86400");
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="preview.png"');
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("ETag")).toBe(buildSha256EntityTag("image-bytes"));
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("serves non-image attachments as downloads even when they come from contact threads", async () => {
    const response = await GET(new Request("http://localhost/api/attachments/att-file"), {
      params: Promise.resolve({ attachmentId: "att-file" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="summary.pdf"');
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.headers.get("ETag")).toBe(buildSha256EntityTag("pdf-bytes"));
    expect(await response.text()).toBe("pdf-bytes");
  });

  it("returns a 304 for authorized file attachments when the entity tag still matches", async () => {
    const response = await GET(
      new Request("http://localhost/api/attachments/att-file", {
        headers: {
          "If-None-Match": buildSha256EntityTag("pdf-bytes"),
        },
      }),
      {
        params: Promise.resolve({ attachmentId: "att-file" }),
      },
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="summary.pdf"');
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("ETag")).toBe(buildSha256EntityTag("pdf-bytes"));
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("returns 404 instead of throwing when a TOS attachment object is missing", async () => {
    const state = readWorkspaceStateSync();
    writeWorkspaceStateSync({
      ...state,
      messages: [
        ...state.messages,
        {
          id: "message-missing",
          channel: "tour visit",
          speaker: "Atlas",
          role: "agent",
          time: "10:08",
          summary: "Missing TOS attachment.",
          status: "completed",
          attachments: [
            {
              id: "att-missing-tos",
              fileName: "missing.txt",
              mediaType: "text/plain",
              sizeBytes: 42,
              kind: "file",
              storedPath: "tos://test-bucket/workspaces/default/attachments/att-missing-tos/missing.txt",
              storageProvider: "tos",
              storageKey: "workspaces/default/attachments/att-missing-tos/missing.txt",
            },
          ],
        },
      ],
    }, "default", { skipVersionCheck: true });

    const response = await GET(new Request("http://localhost/api/attachments/att-missing-tos"), {
      params: Promise.resolve({ attachmentId: "att-missing-tos" }),
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Attachment not found.");
  });

  it("does not expose attachments from channels the current user cannot access", async () => {
    const response = await GET(
      new Request("http://localhost/api/attachments/att-hidden", {
        headers: {
          "If-None-Match": "*",
        },
      }),
      {
        params: Promise.resolve({ attachmentId: "att-hidden" }),
      },
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Attachment not found.");
  });

  it("does not let workspace owners download attachments from direct channels they do not participate in", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("default", "Northstar Labs", "owner"));

    const hiddenResponse = await GET(new Request("http://localhost/api/attachments/att-hidden"), {
      params: Promise.resolve({ attachmentId: "att-hidden" }),
    });
    expect(hiddenResponse.status).toBe(404);
    expect(await hiddenResponse.text()).toBe("Attachment not found.");

    const ownDirectResponse = await GET(new Request("http://localhost/api/attachments/att-file"), {
      params: Promise.resolve({ attachmentId: "att-file" }),
    });
    expect(ownDirectResponse.status).toBe(200);
    expect(await ownDirectResponse.text()).toBe("pdf-bytes");
  });

  it("encodes unicode filenames so the response headers stay valid", async () => {
    const response = await GET(new Request("http://localhost/api/attachments/att-file-unicode"), {
      params: Promise.resolve({ attachmentId: "att-file-unicode" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/markdown");
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="____.md"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E7%BA%AA%E8%A6%81.md`,
    );
    expect(await response.text()).toBe("unicode-bytes");
  });

  it("serves attachments kept alive by knowledge-page source tracking even after the source message is gone", async () => {
    const response = await GET(new Request("http://localhost/api/attachments/att-orphan-knowledge"), {
      params: Promise.resolve({ attachmentId: "att-orphan-knowledge" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/markdown");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="orphan-note.md"');
    expect(await response.text()).toBe("orphan-knowledge-bytes");
  });

  it("does not expose knowledge-preserved attachments when their source direct channel is unreadable", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("default", "Northstar Labs", "owner"));

    const response = await GET(new Request("http://localhost/api/attachments/att-hidden"), {
      params: Promise.resolve({ attachmentId: "att-hidden" }),
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Attachment not found.");
  });

  it("scopes attachments to the current workspace and rejects mismatched query ids", async () => {
    const forbiddenResponse = await GET(
      new Request("http://localhost/api/attachments/att-workspace?workspaceId=workspace-mars"),
      {
        params: Promise.resolve({ attachmentId: "att-workspace" }),
      },
    );
    expect(forbiddenResponse.status).toBe(403);
    expect(readWorkspaceStateSync().ledger[0]).toMatchObject({
      code: "workspace.cross_workspace_access_denied",
      data: expect.objectContaining({
        actorType: "session_user",
        resourceType: "attachment",
        resourceId: "att-workspace",
        requestedWorkspaceId: "workspace-mars",
      }),
    });

    mockGetCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("workspace-mars", "Mars Labs"));
    const missingResponse = await GET(new Request("http://localhost/api/attachments/att-workspace"), {
      params: Promise.resolve({ attachmentId: "att-workspace" }),
    });
    expect(missingResponse.status).toBe(200);

    const scopedResponse = await GET(
      new Request("http://localhost/api/attachments/att-workspace?workspaceId=workspace-mars"),
      {
        params: Promise.resolve({ attachmentId: "att-workspace" }),
      },
    );

    expect(scopedResponse.status).toBe(200);
    expect(scopedResponse.headers.get("Content-Type")).toBe("text/plain");
    expect(await missingResponse.text()).toBe("workspace-bytes");
    expect(await scopedResponse.text()).toBe("workspace-bytes");
  });
});

function buildWorkspaceContext(
  workspaceId = "default",
  workspaceName = "Northstar Labs",
  workspaceRole: "owner" | "admin" | "member" = "member",
) {
  return {
    currentUser: {
      id: "user-1",
      organizationName: workspaceName,
      displayName: "techwu",
      role: workspaceRole,
      email: "techwu@example.com",
    },
    currentWorkspace: {
      id: workspaceId,
      slug: workspaceId,
      name: workspaceName,
      createdBy: "user-1",
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
    },
    currentMembership: {
      id: `membership-${workspaceId}`,
      workspaceId,
      userId: "user-1",
      role: workspaceRole,
      status: "active",
      joinedAt: "2026-04-22T00:00:00.000Z",
    },
    memberships: [
      {
        id: `membership-${workspaceId}`,
        workspaceId,
        userId: "user-1",
        role: workspaceRole,
        status: "active",
        joinedAt: "2026-04-22T00:00:00.000Z",
      },
    ],
    workspaces: [
      {
        id: workspaceId,
        slug: workspaceId,
        name: workspaceName,
        createdBy: "user-1",
        createdAt: "2026-04-22T00:00:00.000Z",
        updatedAt: "2026-04-22T00:00:00.000Z",
      },
    ],
  };
}

function ensureTestWorkspace(workspaceId: string, workspaceName: string): void {
  const existing = getDatabase().prepare("SELECT 1 FROM workspace WHERE id = ? LIMIT 1").get(workspaceId);
  if (existing) {
    return;
  }

  createWorkspaceSync({
    id: workspaceId,
    slug: workspaceId,
    name: workspaceName,
    createdBy: "user-1",
  });
}

function buildSha256EntityTag(value: string): string {
  return `"sha256-${createHash("sha256").update(value).digest("hex")}"`;
}
