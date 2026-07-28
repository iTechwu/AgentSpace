import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetWorkspacePageContext,
  mockLoadWorkspaceModuleDataWithMeta,
  mockRedirect,
  mockResolveAgentRuntimeMode,
} = vi.hoisted(() => ({
  mockGetWorkspacePageContext: vi.fn(),
  mockLoadWorkspaceModuleDataWithMeta: vi.fn(),
  mockRedirect: vi.fn((target: string) => {
    throw new Error(`redirect:${target}`);
  }),
  mockResolveAgentRuntimeMode: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("@dofe-agent/services", () => ({
  resolveAgentRuntimeMode: mockResolveAgentRuntimeMode,
}));

vi.mock("@/features/dashboard/workspace-module-loaders", () => ({
  loadWorkspaceModuleDataWithMeta: mockLoadWorkspaceModuleDataWithMeta,
}));

vi.mock("../_lib/workspace-page-context", () => ({
  getWorkspacePageContext: mockGetWorkspacePageContext,
}));

vi.mock("@/features/agents/agents-page-client", () => ({
  AgentsPageClient: () => null,
}));

import WorkspaceAgentsPage from "./page";

describe("workspace agents route runtime management compatibility", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockResolveAgentRuntimeMode.mockReset();
    mockGetWorkspacePageContext.mockReset();
    mockLoadWorkspaceModuleDataWithMeta.mockReset();
    mockGetWorkspacePageContext.mockResolvedValue({
      currentMembership: { role: "owner" },
      currentUser: {
        id: "user-1",
        displayName: "Mina",
        email: "mina@example.com",
      },
      currentWorkspace: {
        id: "workspace-mars",
        slug: "mars-labs",
      },
    });
    mockLoadWorkspaceModuleDataWithMeta.mockResolvedValue({
      data: { data: {}, moduleId: "agents" },
      meta: { durationMs: 1 },
    });
  });

  it("redirects the legacy container view to managed runtimes in remote mode", async () => {
    mockResolveAgentRuntimeMode.mockReturnValue("remote");

    await expect(WorkspaceAgentsPage({
      params: Promise.resolve({ workspaceSlug: "mars-labs" }),
      searchParams: Promise.resolve({ mode: "container" }),
    })).rejects.toThrow("redirect:/w/mars-labs/runtimes");

    expect(mockLoadWorkspaceModuleDataWithMeta).not.toHaveBeenCalled();
  });

  it("keeps the legacy container view available in local mode", async () => {
    mockResolveAgentRuntimeMode.mockReturnValue("local");

    await WorkspaceAgentsPage({
      params: Promise.resolve({ workspaceSlug: "mars-labs" }),
      searchParams: Promise.resolve({ mode: "container" }),
    });

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockLoadWorkspaceModuleDataWithMeta).toHaveBeenCalledWith(
      "agents",
      "workspace-mars",
      expect.objectContaining({ id: "user-1", role: "owner" }),
    );
  });
});
