import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCountUnreadNotificationsSync,
  mockGetPendingApprovalCount,
  mockListDaemonSnapshotsSync,
  mockListRuntimeGrantsSync,
  mockListWorkspaceMemberUsersSync,
  mockListWorkspaceSkillsSync,
  mockReadWorkspaceStateSnapshotSync,
  mockResolveChannelHumanMemberCount,
} = vi.hoisted(() => ({
  mockCountUnreadNotificationsSync: vi.fn(),
  mockGetPendingApprovalCount: vi.fn(),
  mockListDaemonSnapshotsSync: vi.fn(),
  mockListRuntimeGrantsSync: vi.fn(),
  mockListWorkspaceMemberUsersSync: vi.fn(),
  mockListWorkspaceSkillsSync: vi.fn(),
  mockReadWorkspaceStateSnapshotSync: vi.fn(),
  mockResolveChannelHumanMemberCount: vi.fn(),
}));

vi.mock("@agent-space/db", () => ({
  DEFAULT_WORKSPACE_ID: "default",
  listDaemonSnapshotsSync: mockListDaemonSnapshotsSync,
  listRuntimeGrantsSync: mockListRuntimeGrantsSync,
  listWorkspaceMemberUsersSync: mockListWorkspaceMemberUsersSync,
}));

vi.mock("@agent-space/services", () => ({
  countUnreadNotificationsSync: mockCountUnreadNotificationsSync,
  listWorkspaceSkillsSync: mockListWorkspaceSkillsSync,
  readWorkspaceStateSnapshotSync: mockReadWorkspaceStateSnapshotSync,
  resolveChannelHumanMemberCount: mockResolveChannelHumanMemberCount,
}));

vi.mock("@/features/approvals/approval-queue-data", () => ({
  getPendingApprovalCount: mockGetPendingApprovalCount,
}));

import {
  getWorkspaceShellCounterData,
  getWorkspaceShellData,
  getWorkspaceShellStableData,
} from "@/features/dashboard/workspace-shell-data";

describe("workspace shell data", () => {
  beforeEach(() => {
    mockCountUnreadNotificationsSync.mockReset();
    mockGetPendingApprovalCount.mockReset();
    mockListDaemonSnapshotsSync.mockReset();
    mockListRuntimeGrantsSync.mockReset();
    mockListWorkspaceMemberUsersSync.mockReset();
    mockListWorkspaceSkillsSync.mockReset();
    mockReadWorkspaceStateSnapshotSync.mockReset();
    mockResolveChannelHumanMemberCount.mockReset();

    mockReadWorkspaceStateSnapshotSync.mockReturnValue({
      organizationName: "Northstar Labs",
      activeEmployees: [
        buildEmployee({ name: "Planner", ownerUserId: "user-1", remarkName: "Planning Agent" }),
        buildEmployee({ name: "Researcher", ownerUserId: "user-2" }),
      ],
      channels: [
        { name: "general", humanMembers: 2, employeeNames: ["Planner", "Researcher"] },
        { name: "direct-agent", kind: "direct", humanMembers: 1, employeeNames: ["Planner"] },
      ],
      knowledgePages: [
        { id: "page-1", title: "Roadmap" },
        { id: "page-2", title: "Runbook" },
      ],
      tasks: [
        { id: "task-1", assignee: "Planner", status: "todo" },
        { id: "task-2", assignee: "Researcher", status: "done" },
      ],
    });
    mockListWorkspaceMemberUsersSync.mockReturnValue([
      { userId: "user-1", displayName: "techwu", role: "owner", primaryEmail: "techwu@example.com" },
      { userId: "user-2", displayName: "Mina", role: "member", primaryEmail: "mina@example.com" },
    ]);
    mockListWorkspaceSkillsSync.mockReturnValue([{ id: "skill-1" }, { id: "skill-2" }]);
    mockListDaemonSnapshotsSync.mockReturnValue([
      {
        daemon: { id: "daemon-1" },
        runtimes: [
          { id: "runtime-1", name: "Codex Box", provider: "codex", status: "online" },
          { id: "runtime-2", name: "Offline Box", provider: "claude", status: "offline" },
        ],
      },
    ]);
    mockListRuntimeGrantsSync.mockReturnValue([]);
    mockResolveChannelHumanMemberCount.mockReturnValue(2);
    mockGetPendingApprovalCount.mockReturnValue(4);
    mockCountUnreadNotificationsSync.mockImplementation(({ recipientId }: { recipientId: string }) =>
      recipientId === "user-1" ? 3 : 2,
    );
  });

  it("builds stable shell, counter shell, and the legacy full shell from the same visibility context", () => {
    const fullShell = getWorkspaceShellData("techwu", "workspace-1", "user-1", "owner");
    const stableShell = getWorkspaceShellStableData("techwu", "workspace-1", "user-1", "owner");
    const counters = getWorkspaceShellCounterData("techwu", "workspace-1", "user-1", "owner");

    expect(stableShell).toMatchObject({
      organizationName: "Northstar Labs",
      channels: [{ name: "general", memberLabel: "2 humans / 2 agents" }],
      humanContacts: [{ id: "user-2", name: "Mina", subtitle: "mina@example.com" }],
      agents: [
        { id: "Planner", name: "Planning Agent", subtitle: "Planner", status: "idle" },
        { id: "Researcher", name: "Researcher", subtitle: "Researcher", status: "idle" },
      ],
      directMessages: [{ id: "runtime-1", name: "Codex Box", subtitle: "Codex", status: "idle" }],
    });
    expect(counters).toMatchObject({
      humanMembers: 2,
      channelCount: 1,
      messageCount: 3,
      unreadNotificationCount: 5,
      openTaskCount: 1,
      pendingApprovalCount: 4,
      localAgentCount: 2,
      remoteAgentCount: 1,
      skillCount: 2,
      knowledgePageCount: 2,
      contactCount: 3,
      humanContactCount: 1,
      agentCount: 2,
      runtimeCount: 1,
    });
    expect(fullShell).toMatchObject({
      ...stableShell,
      humanMembers: counters.humanMembers,
      channelCount: counters.channelCount,
      messageCount: counters.messageCount,
      unreadNotificationCount: counters.unreadNotificationCount,
      openTaskCount: counters.openTaskCount,
      pendingApprovalCount: counters.pendingApprovalCount,
      localAgentCount: counters.localAgentCount,
      remoteAgentCount: counters.remoteAgentCount,
      skillCount: counters.skillCount,
      knowledgePageCount: counters.knowledgePageCount,
      contactCount: counters.contactCount,
    });
  });

  it("uses channel scope for stable shell and counters without leaking workspace-wide contacts", () => {
    const stableShell = getWorkspaceShellStableData("techwu", "workspace-1", "user-1", "member", {
      channelNames: ["general"],
    });
    const counters = getWorkspaceShellCounterData("techwu", "workspace-1", "user-1", "member", {
      channelNames: ["general"],
    });

    expect(stableShell.humanContacts).toEqual([]);
    expect(stableShell.directMessages).toEqual([]);
    expect(stableShell.agents.map((agent) => agent.id)).toEqual(["Planner", "Researcher"]);
    expect(counters).toMatchObject({
      humanMembers: 0,
      channelCount: 1,
      messageCount: 1,
      pendingApprovalCount: 0,
      contactCount: 0,
      runtimeCount: 0,
    });
  });
});

function buildEmployee(input: {
  name: string;
  ownerUserId: string;
  remarkName?: string;
}) {
  return {
    name: input.name,
    role: "Product agent",
    remarkName: input.remarkName,
    ownerUserId: input.ownerUserId,
    origin: "seed",
    summary: "",
    traits: [],
    fit: "",
    skillIds: [],
    channels: ["general"],
    status: "active",
  };
}
