import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockGetWorkspacePageContext,
  mockLoadWorkspaceModuleDataWithMeta,
  mockRedirect,
} = vi.hoisted(() => ({
  mockGetWorkspacePageContext: vi.fn(),
  mockLoadWorkspaceModuleDataWithMeta: vi.fn(),
  mockRedirect: vi.fn((target: string) => {
    throw new Error(`redirect:${target}`);
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("@/features/dashboard/workspace-module-loaders", () => ({
  loadWorkspaceModuleDataWithMeta: mockLoadWorkspaceModuleDataWithMeta,
}));

vi.mock("../_lib/workspace-page-context", () => ({
  getWorkspacePageContext: mockGetWorkspacePageContext,
}));

vi.mock("@/features/channels/channels-page-client", () => ({
  ChannelsPageClient: () => null,
}));

vi.mock("@/features/dashboard/workspace-initial-module-data", () => ({
  WorkspaceInitialModuleData: ({ children }: { children: React.ReactNode }) => children,
}));

import WorkspaceMessagesPage from "./page";

describe("workspace messages route compatibility", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockLoadWorkspaceModuleDataWithMeta.mockReset();
    mockGetWorkspacePageContext.mockReset();
    mockGetWorkspacePageContext.mockResolvedValue({
      accessScope: "workspace",
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
  });

  it("redirects the legacy contacts context to the canonical contacts URL", async () => {
    await expect(WorkspaceMessagesPage({
      params: Promise.resolve({ workspaceSlug: "mars-labs" }),
      searchParams: Promise.resolve({
        context: "contacts",
        view: "direct",
        focus: "contact:Atlas",
      }),
    })).rejects.toThrow(
      "redirect:/w/workspace-mars/contacts?view=digital&focus=contact%3AAtlas",
    );

    expect(mockLoadWorkspaceModuleDataWithMeta).not.toHaveBeenCalled();
  });
});
