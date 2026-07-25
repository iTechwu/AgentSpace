import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetWorkspaceStateSync, writeWorkspaceStateSync } from "@agent-space/services";

const { mockGetCurrentWorkspaceContext } = vi.hoisted(() => ({
  mockGetCurrentWorkspaceContext: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({
  getCurrentWorkspaceContext: mockGetCurrentWorkspaceContext,
}));

import { GET } from "./route";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "agent-space-workspace-context-route-"));

beforeAll(() => {
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

beforeEach(() => {
  mockGetCurrentWorkspaceContext.mockReset();
  mockGetCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext());

  const defaultState = resetWorkspaceStateSync();
  writeWorkspaceStateSync({
    ...defaultState,
    organizationName: "Northstar Labs",
    activeEmployees: [
      {
        name: "Atlas",
        role: "Planner",
        remarkName: "Atlas",
        origin: "manual",
        summary: "Default workspace agent",
        traits: [],
        fit: "default",
        skillIds: [],
        channels: ["north-ops"],
        status: "active",
        instructions: "",
      },
      {
        name: "Echo",
        role: "Reviewer",
        remarkName: "Echo",
        origin: "manual",
        summary: "Default teammate",
        traits: [],
        fit: "default",
        skillIds: [],
        channels: ["north-ops"],
        status: "active",
        instructions: "",
      },
    ],
    channels: [
      {
        name: "north-ops",
        humanMembers: 1,
        employeeNames: ["Atlas", "Echo"],
      },
    ],
  });

  const marsState = resetWorkspaceStateSync("workspace-mars");
  writeWorkspaceStateSync({
    ...marsState,
    organizationName: "Mars Labs",
    activeEmployees: [
      {
        name: "Atlas",
        role: "Planner",
        remarkName: "Atlas",
        origin: "manual",
        summary: "Mars workspace agent",
        traits: [],
        fit: "mars",
        skillIds: [],
        channels: ["mars-ops"],
        status: "active",
        instructions: "",
      },
      {
        name: "Nova",
        role: "Researcher",
        remarkName: "Nova",
        origin: "manual",
        summary: "Mars teammate",
        traits: [],
        fit: "mars",
        skillIds: [],
        channels: ["mars-ops"],
        status: "active",
        instructions: "",
      },
    ],
    channels: [
      {
        name: "mars-ops",
        humanMembers: 1,
        employeeNames: ["Atlas", "Nova"],
      },
    ],
  }, "workspace-mars");
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe("workspace context route", () => {
  it("rejects unauthenticated requests", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValueOnce(null);

    const response = await GET(new Request("http://localhost/api/workspace-context?action=list_channels&agent=Atlas"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "Unauthorized." });
  });

  it("reads context data from the current workspace only", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("workspace-mars", "Mars Labs"));

    const response = await GET(new Request("http://localhost/api/workspace-context?action=list_channels&agent=Atlas"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.channels).toEqual([
      {
        name: "mars-ops",
        memberNames: ["Nova"],
        documentCount: 0,
      },
    ]);
  });

  it("rejects non-admin workspace members", async () => {
    mockGetCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("workspace-mars", "Mars Labs", "member"));

    const response = await GET(new Request("http://localhost/api/workspace-context?action=list_channels&agent=Atlas"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "Forbidden." });
  });
});

function buildWorkspaceContext(
  workspaceId = "default",
  workspaceName = "Northstar Labs",
  membershipRole: "owner" | "admin" | "member" = "owner",
) {
  return {
    currentUser: {
      id: "user-1",
      organizationName: workspaceName,
      displayName: "techwu",
      role: "owner",
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
      role: membershipRole,
      status: "active",
      joinedAt: "2026-04-22T00:00:00.000Z",
    },
    memberships: [
      {
        id: `membership-${workspaceId}`,
        workspaceId,
        userId: "user-1",
        role: membershipRole,
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
