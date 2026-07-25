import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateAutomationRuleSync,
  mockCreateDataTableSync,
  mockCreateKnowledgePageSync,
  mockCreateScheduledTaskSync,
  mockCreateTemplateSync,
  mockRevalidateWorkspacePath,
  mockRequireCurrentWorkspaceContext,
} = vi.hoisted(() => ({
  mockCreateAutomationRuleSync: vi.fn(),
  mockCreateDataTableSync: vi.fn(),
  mockCreateKnowledgePageSync: vi.fn(),
  mockCreateScheduledTaskSync: vi.fn(),
  mockCreateTemplateSync: vi.fn(),
  mockRevalidateWorkspacePath: vi.fn(),
  mockRequireCurrentWorkspaceContext: vi.fn(),
}));

vi.mock("@agent-space/services", () => ({
  createAutomationRuleSync: mockCreateAutomationRuleSync,
  createDataTableSync: mockCreateDataTableSync,
  createKnowledgePageSync: mockCreateKnowledgePageSync,
  createScheduledTaskSync: mockCreateScheduledTaskSync,
  createTemplateSync: mockCreateTemplateSync,
}));

vi.mock("@/features/auth/server-workspace", () => ({
  requireCurrentWorkspaceContext: mockRequireCurrentWorkspaceContext,
}));

vi.mock("@/features/auth/workspace-revalidation", () => ({
  revalidateWorkspacePath: mockRevalidateWorkspacePath,
}));

import { createAutomationRuleAction } from "@/features/automations/actions";
import { createScheduledTaskAction } from "@/features/calendar/actions";
import { createKnowledgePageAction } from "@/features/knowledge/actions";
import { createDataTableAction } from "@/features/tables/actions";
import { createTemplateAction } from "@/features/templates/actions";

describe("workspace admin-guarded actions", () => {
  beforeEach(() => {
    mockCreateAutomationRuleSync.mockReset();
    mockCreateDataTableSync.mockReset();
    mockCreateKnowledgePageSync.mockReset();
    mockCreateScheduledTaskSync.mockReset();
    mockCreateTemplateSync.mockReset();
    mockRevalidateWorkspacePath.mockReset();
    mockRequireCurrentWorkspaceContext.mockReset();
  });

  it("rejects member writes for shared automation, schedule, knowledge, template, and table actions", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("member"));

    await expect(createAutomationRuleAction({
      name: "Auto route",
      trigger: { type: "message_received", config: { channelName: "general" } },
      actions: [{ type: "create_task", config: { titleTemplate: "Follow up" } }],
    })).rejects.toThrow("Forbidden.");
    await expect(createScheduledTaskAction({
      title: "Sync",
      repeat: "once",
      scheduledAt: "2026-04-24T12:00:00.000Z",
    })).rejects.toThrow("Forbidden.");
    await expect(createKnowledgePageAction({
      title: "Ops notes",
    })).rejects.toThrow("Forbidden.");
    await expect(createTemplateAction({
      category: "task",
      name: "Task template",
      configJson: "{}",
    })).rejects.toThrow("Forbidden.");
    await expect(createDataTableAction({
      name: "Pipeline",
      columns: [{ name: "Stage", type: "text" }],
    })).rejects.toThrow("Forbidden.");

    expect(mockCreateAutomationRuleSync).not.toHaveBeenCalled();
    expect(mockCreateScheduledTaskSync).not.toHaveBeenCalled();
    expect(mockCreateKnowledgePageSync).not.toHaveBeenCalled();
    expect(mockCreateTemplateSync).not.toHaveBeenCalled();
    expect(mockCreateDataTableSync).not.toHaveBeenCalled();
  });

  it("allows admins to perform shared writes", async () => {
    mockRequireCurrentWorkspaceContext.mockResolvedValue(buildWorkspaceContext("admin"));

    await createAutomationRuleAction({
      name: "Auto route",
      trigger: { type: "message_received", config: { channelName: "general" } },
      actions: [{ type: "create_task", config: { titleTemplate: "Follow up" } }],
    });
    await createScheduledTaskAction({
      title: "Sync",
      repeat: "once",
      scheduledAt: "2026-04-24T12:00:00.000Z",
    });
    await createKnowledgePageAction({
      title: "Ops notes",
    });
    await createTemplateAction({
      category: "task",
      name: "Task template",
      configJson: "{}",
    });
    await createDataTableAction({
      name: "Pipeline",
      columns: [{ name: "Stage", type: "text" }],
    });

    expect(mockCreateAutomationRuleSync).toHaveBeenCalledWith({
      name: "Auto route",
      trigger: { type: "message_received", config: { channelName: "general" } },
      actions: [{ type: "create_task", config: { titleTemplate: "Follow up" } }],
    }, "workspace-1");
    expect(mockCreateScheduledTaskSync).toHaveBeenCalledWith({
      title: "Sync",
      repeat: "once",
      scheduledAt: "2026-04-24T12:00:00.000Z",
    }, "workspace-1");
    expect(mockCreateKnowledgePageSync).toHaveBeenCalledWith({
      title: "Ops notes",
      createdBy: "techwu",
    }, "workspace-1");
    expect(mockCreateTemplateSync).toHaveBeenCalledWith({
      category: "task",
      name: "Task template",
      configJson: "{}",
    }, "workspace-1");
    expect(mockCreateDataTableSync).toHaveBeenCalledWith({
      name: "Pipeline",
      columns: [{ name: "Stage", type: "text" }],
    }, "workspace-1");
  });
});

function buildWorkspaceContext(role: "owner" | "admin" | "member") {
  return {
    currentUser: {
      id: "user-1",
      organizationName: "Northstar Labs",
      displayName: "techwu",
      role: "owner",
      email: "techwu@example.com",
    },
    currentWorkspace: {
      id: "workspace-1",
      slug: "workspace-1",
      name: "Northstar Labs",
      createdBy: "user-1",
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
    },
    currentMembership: {
      id: "membership-1",
      workspaceId: "workspace-1",
      userId: "user-1",
      role,
      status: "active",
      joinedAt: "2026-04-22T00:00:00.000Z",
    },
    memberships: [],
    workspaces: [],
  };
}
