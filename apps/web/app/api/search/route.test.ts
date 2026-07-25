import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { createWorkspaceSync, getDatabase } from "@agent-space/db";
import { readWorkspaceStateSync, resetWorkspaceStateSync, writeWorkspaceStateSync } from "@agent-space/services";

const { mockGetCurrentWorkspaceContext } = vi.hoisted(() => ({
  mockGetCurrentWorkspaceContext: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({
  getCurrentWorkspaceContext: mockGetCurrentWorkspaceContext,
}));

import { GET } from "./route";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "agent-space-search-route-"));

beforeAll(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  mockGetCurrentWorkspaceContext.mockReset();
  mockGetCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext());
  ensureTestWorkspace("default", "Northstar Labs");
  ensureTestWorkspace("workspace-mars", "Mars Labs");

  const defaultState = resetWorkspaceStateSync();
  writeWorkspaceStateSync({
    ...defaultState,
    organizationName: "Northstar Labs",
    humanMembers: [{ name: "techwu", role: "Founder" }, { name: "Mina", role: "Operator" }],
    channels: [
      {
        name: "north-ops",
        humanMemberNames: ["techwu"],
        humanMembers: 1,
        employeeNames: ["Atlas"],
      },
      {
        name: "secret-ops",
        humanMemberNames: ["Mina"],
        humanMembers: 1,
        employeeNames: ["Atlas"],
      },
    ],
    messages: [
      {
        id: "message-default",
        channel: "north-ops",
        speaker: "Atlas",
        role: "agent",
        time: "10:00",
        summary: "apollo default note",
        status: "completed",
        attachments: [
          {
            id: "att-visible-itinerary",
            fileName: "shared/itinerary.md",
            mediaType: "text/markdown",
            sizeBytes: 128,
            kind: "file",
            storedPath: join(tempRoot, "data", "visible-itinerary.md"),
          },
        ],
      },
      {
        id: "message-secret",
        channel: "secret-ops",
        speaker: "Atlas",
        role: "agent",
        time: "10:05",
        summary: "apollo hidden note",
        status: "completed",
        attachments: [
          {
            id: "att-hidden-brief",
            fileName: "shared/hidden-brief.md",
            mediaType: "text/markdown",
            sizeBytes: 64,
            kind: "file",
            storedPath: join(tempRoot, "data", "hidden-brief.md"),
          },
        ],
      },
    ],
    channelDocuments: [
      {
        id: "doc-visible",
        channelName: "north-ops",
        title: "Travel handbook",
        slug: "travel-handbook",
        kind: "markdown",
        storageMode: "native",
        status: "active",
        currentVersionId: "doc-visible-v1",
        summary: "visible handbook",
        lastEditorType: "human",
        createdBy: "techwu",
        updatedBy: "techwu",
        createdAt: "2026-04-22T09:00:00.000Z",
        updatedAt: "2026-04-22T09:00:00.000Z",
      },
      {
        id: "doc-secret",
        channelName: "north-ops",
        title: "Apollo restricted plan",
        slug: "apollo-restricted-plan",
        kind: "markdown",
        storageMode: "native",
        status: "active",
        currentVersionId: "doc-secret-v1",
        summary: "restricted",
        lastEditorType: "human",
        createdBy: "Mina",
        updatedBy: "Mina",
        createdAt: "2026-04-22T10:00:00.000Z",
        updatedAt: "2026-04-22T10:00:00.000Z",
      },
    ],
    channelDocumentVersions: [
      {
        id: "doc-visible-v1",
        documentId: "doc-visible",
        contentMarkdown: "travel handbook content",
        summary: "visible handbook",
        createdBy: "techwu",
        createdByType: "human",
        triggerType: "manual",
        createdAt: "2026-04-22T09:00:00.000Z",
      },
      {
        id: "doc-secret-v1",
        documentId: "doc-secret",
        contentMarkdown: "apollo restricted plan",
        summary: "restricted",
        createdBy: "Mina",
        createdByType: "human",
        triggerType: "manual",
        createdAt: "2026-04-22T10:00:00.000Z",
      },
    ],
    channelDocumentAccesses: [
      {
        id: "access-visible",
        documentId: "doc-visible",
        actorId: "techwu",
        actorType: "human",
        role: "owner",
        createdAt: "2026-04-22T09:00:00.000Z",
        updatedAt: "2026-04-22T09:00:00.000Z",
      },
      {
        id: "access-secret",
        documentId: "doc-secret",
        actorId: "Mina",
        actorType: "human",
        role: "owner",
        createdAt: "2026-04-22T10:00:00.000Z",
        updatedAt: "2026-04-22T10:00:00.000Z",
      },
    ],
  });

  const marsState = resetWorkspaceStateSync("workspace-mars");
  writeWorkspaceStateSync({
    ...marsState,
    organizationName: "Mars Labs",
    humanMembers: [{ name: "techwu", role: "Founder" }],
    channels: [
      {
        name: "mars-ops",
        humanMemberNames: ["techwu"],
        humanMembers: 1,
        employeeNames: ["Nova"],
      },
    ],
    messages: [
      {
        id: "message-mars",
        channel: "mars-ops",
        speaker: "Nova",
        role: "agent",
        time: "11:00",
        summary: "apollo mars note",
        status: "completed",
      },
    ],
  }, "workspace-mars");
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("search route", () => {
  it("rejects unauthenticated requests", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValueOnce(null);

    const response = await GET(new NextRequest("http://localhost/api/search?q=apollo"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "Unauthorized." });
  });

  it("rejects mismatched workspace ids in the query string", async () => {
    const response = await GET(new NextRequest("http://localhost/api/search?q=apollo&workspaceId=workspace-mars"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden." });
    expect(readWorkspaceStateSync().ledger[0]).toMatchObject({
      code: "workspace.cross_workspace_access_denied",
      data: expect.objectContaining({
        actorType: "session_user",
        resourceType: "search",
        requestedWorkspaceId: "workspace-mars",
      }),
    });
  });

  it("scopes results to the current workspace instead of trusting the query string", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("workspace-mars", "Mars Labs"));

    const response = await GET(new NextRequest("http://localhost/api/search?q=apollo"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]?.id).toBe("message-mars");
    expect(payload.results[0]?.meta?.channel).toBe("mars-ops");
  });

  it("filters out results from channels the current user cannot access", async () => {
    const response = await GET(new NextRequest("http://localhost/api/search?q=apollo"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.results.map((result: { id: string }) => result.id)).toEqual(["message-default"]);
  });

  it("returns no results when the request targets an inaccessible channel", async () => {
    const response = await GET(new NextRequest("http://localhost/api/search?q=apollo&channel=secret-ops"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.results).toEqual([]);
  });

  it("filters out channel documents the current user no longer has document access to", async () => {
    const response = await GET(new NextRequest("http://localhost/api/search?q=restricted"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.results).toEqual([]);
  });

  it("returns visible knowledge document-page results for shared channel documents", async () => {
    const response = await GET(new NextRequest("http://localhost/api/search?q=handbook&types=document"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.results).toEqual([
      expect.objectContaining({
        type: "document",
        id: "doc-visible",
        title: "Travel handbook",
        meta: expect.objectContaining({
          documentKey: "channelDocument:doc-visible",
          sourceType: "channelDocument",
          view: "documents",
        }),
      }),
    ]);
  });

  it("returns visible knowledge document-page results for shared attachments only from accessible channels", async () => {
    const response = await GET(new NextRequest("http://localhost/api/search?q=itinerary&types=document"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.results).toEqual([
      expect.objectContaining({
        type: "document",
        id: "att-visible-itinerary",
        title: "shared/itinerary.md",
        meta: expect.objectContaining({
          documentKey: "attachment:att-visible-itinerary",
          sourceType: "attachment",
          view: "documents",
        }),
      }),
    ]);
  });

  it("does not leak hidden shared attachments through knowledge document-page search", async () => {
    const response = await GET(new NextRequest("http://localhost/api/search?q=hidden-brief&types=document"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.results).toEqual([]);
  });

  it("does not expose another member's direct-channel results to a workspace owner", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("default", "Northstar Labs", "owner"));
    writeWorkspaceStateSync({
      ...readWorkspaceStateSync(),
      channels: [
        {
          name: "direct-finance",
          kind: "direct",
          humanMemberNames: ["Mina"],
          humanMembers: 1,
          employeeNames: ["Atlas"],
        },
        {
          name: "group-ops",
          kind: "group",
          humanMemberNames: ["Mina"],
          humanMembers: 1,
          employeeNames: ["Atlas"],
        },
      ],
      messages: [
        {
          id: "message-direct-private",
          channel: "direct-finance",
          speaker: "Atlas",
          role: "agent",
          time: "10:00",
          summary: "apollo private direct note",
          status: "completed",
        },
        {
          id: "message-group-visible",
          channel: "group-ops",
          speaker: "Atlas",
          role: "agent",
          time: "10:05",
          summary: "apollo group note",
          status: "completed",
        },
      ],
      tasks: [
        {
          id: "task-direct-private",
          title: "apollo private direct task",
          channel: "direct-finance",
          assignee: "Atlas",
          priority: "medium",
          status: "todo",
        },
        {
          id: "task-group-visible",
          title: "apollo group task",
          channel: "group-ops",
          assignee: "Atlas",
          priority: "medium",
          status: "todo",
        },
      ],
      channelDocuments: [
        {
          id: "doc-direct-private",
          channelName: "direct-finance",
          title: "Apollo private direct document",
          slug: "apollo-private-direct-document",
          kind: "markdown",
          storageMode: "native",
          status: "active",
          currentVersionId: "doc-direct-private-v1",
          summary: "private direct",
          lastEditorType: "human",
          createdBy: "Mina",
          updatedBy: "Mina",
          createdAt: "2026-04-22T10:00:00.000Z",
          updatedAt: "2026-04-22T10:00:00.000Z",
        },
        {
          id: "doc-group-visible",
          channelName: "group-ops",
          title: "Apollo group document",
          slug: "apollo-group-document",
          kind: "markdown",
          storageMode: "native",
          status: "active",
          currentVersionId: "doc-group-visible-v1",
          summary: "group",
          lastEditorType: "human",
          createdBy: "Mina",
          updatedBy: "Mina",
          createdAt: "2026-04-22T10:05:00.000Z",
          updatedAt: "2026-04-22T10:05:00.000Z",
        },
      ],
      channelDocumentVersions: [
        {
          id: "doc-direct-private-v1",
          documentId: "doc-direct-private",
          contentMarkdown: "apollo private direct document body",
          summary: "private direct",
          createdBy: "Mina",
          createdByType: "human",
          triggerType: "manual",
          createdAt: "2026-04-22T10:00:00.000Z",
        },
        {
          id: "doc-group-visible-v1",
          documentId: "doc-group-visible",
          contentMarkdown: "apollo group document body",
          summary: "group",
          createdBy: "Mina",
          createdByType: "human",
          triggerType: "manual",
          createdAt: "2026-04-22T10:05:00.000Z",
        },
      ],
    });

    const response = await GET(new NextRequest("http://localhost/api/search?q=apollo"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.results.map((result: { id: string }) => result.id)).not.toContain("message-direct-private");
    expect(payload.results.map((result: { id: string }) => result.id)).not.toContain("task-direct-private");
    expect(payload.results.map((result: { id: string }) => result.id)).not.toContain("doc-direct-private");
    expect(payload.results.map((result: { id: string }) => result.id)).toContain("message-group-visible");
    expect(payload.results.map((result: { id: string }) => result.id)).toContain("task-group-visible");
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
