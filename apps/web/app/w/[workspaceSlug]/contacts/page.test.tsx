import { render, screen } from "@testing-library/react";
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
  ChannelsPageClient: () => <div>Digital contacts directory</div>,
}));

vi.mock("@/features/contacts/human-contacts-page-client", () => ({
  HumanContactsPageClient: () => <div>Human contacts directory</div>,
}));

vi.mock("@/features/dashboard/workspace-initial-module-data", () => ({
  WorkspaceInitialModuleData: ({ children }: { children: React.ReactNode }) => children,
}));

import WorkspaceContactsPage from "./page";

describe("workspace contacts route", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockLoadWorkspaceModuleDataWithMeta.mockReset();
    mockGetWorkspacePageContext.mockReset();
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
  });

  it("renders digital employees at the canonical contacts URL", async () => {
    mockLoadWorkspaceModuleDataWithMeta.mockResolvedValue({
      data: {
        moduleId: "contacts",
        view: "digital",
        currentUserDisplayName: "Mina",
        data: {},
      },
      meta: { durationMs: 1 },
    });

    render(await WorkspaceContactsPage({
      params: Promise.resolve({ workspaceSlug: "mars-labs" }),
      searchParams: Promise.resolve({ view: "digital" }),
    }));

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(screen.getByText("Digital contacts directory")).toBeInTheDocument();
    expect(mockLoadWorkspaceModuleDataWithMeta).toHaveBeenCalledWith(
      "contacts",
      "workspace-mars",
      expect.objectContaining({ id: "user-1", role: "owner" }),
      expect.objectContaining({ query: expect.any(URLSearchParams) }),
    );
    const query = mockLoadWorkspaceModuleDataWithMeta.mock.calls[0]?.[3]?.query as URLSearchParams;
    expect(query.toString()).toBe("view=digital");
  });
});
