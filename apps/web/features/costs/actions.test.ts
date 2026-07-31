import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAssertWorkspaceRoleForContext,
  mockBalanceByTenant,
  mockGetModelsInternalClient,
  mockIsModelsInternalConfigured,
  mockReadWorkspaceSsoBindingSync,
  mockRequireCurrentWorkspaceContext,
  mockResolveAgentRuntimeMode,
} = vi.hoisted(() => ({
  mockAssertWorkspaceRoleForContext: vi.fn(),
  mockBalanceByTenant: vi.fn(),
  mockGetModelsInternalClient: vi.fn(),
  mockIsModelsInternalConfigured: vi.fn(),
  mockReadWorkspaceSsoBindingSync: vi.fn(),
  mockRequireCurrentWorkspaceContext: vi.fn(),
  mockResolveAgentRuntimeMode: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => ({
  readBudgetByIdSync: vi.fn(),
  readWorkspaceSsoBindingSync: mockReadWorkspaceSsoBindingSync,
}));

vi.mock("@dofe-agent/services", () => ({
  deleteBudgetSync: vi.fn(),
  getModelsInternalClient: mockGetModelsInternalClient,
  isModelsInternalConfigured: mockIsModelsInternalConfigured,
  listManagedRuntimesForWorkspaceSync: vi.fn(),
  resolveAgentRuntimeMode: mockResolveAgentRuntimeMode,
  syncRuntimeCredentialUsageAsync: vi.fn(),
  toggleBudgetSync: vi.fn(),
  tryRecordWorkspaceAuditEventSync: vi.fn(),
  upsertBudgetSync: vi.fn(),
}));

vi.mock("@/features/auth/server-workspace", () => ({
  requireCurrentWorkspaceContext: mockRequireCurrentWorkspaceContext,
}));

vi.mock("@/features/auth/workspace-permissions", () => ({
  assertWorkspaceRoleForContext: mockAssertWorkspaceRoleForContext,
}));

vi.mock("@/features/auth/workspace-revalidation", () => ({
  revalidateWorkspacePath: vi.fn(),
}));

import { getTeamBillingBalanceAction } from "@/features/costs/actions";

describe("cost actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireCurrentWorkspaceContext.mockResolvedValue({
      currentUser: { id: "user-1", displayName: "Admin" },
      currentWorkspace: { id: "workspace-1", slug: "workspace" },
    });
    mockResolveAgentRuntimeMode.mockReturnValue("remote");
    mockIsModelsInternalConfigured.mockReturnValue(true);
    mockReadWorkspaceSsoBindingSync.mockReturnValue({
      workspaceId: "workspace-1",
      tenantId: "tenant-1",
      teamId: "sso-team-1",
    });
    mockBalanceByTenant.mockResolvedValue({
      balance: "100.00",
      reservedBalance: "10.00",
      availableBalance: "90.00",
      currency: "CNY",
      status: "active",
    });
    mockGetModelsInternalClient.mockReturnValue({
      billing: { balanceByTenant: mockBalanceByTenant },
    });
  });

  it("loads the models balance by the authoritative tenant id", async () => {
    await expect(getTeamBillingBalanceAction()).resolves.toMatchObject({
      balance: "100.00",
      availableBalance: "90.00",
      currency: "CNY",
    });

    expect(mockBalanceByTenant).toHaveBeenCalledWith({ params: { tenantId: "tenant-1" } });
  });

  it("returns a scoped error when the workspace has no models tenant", async () => {
    mockReadWorkspaceSsoBindingSync.mockReturnValue({
      workspaceId: "workspace-1",
      teamId: "sso-team-1",
    });

    await expect(getTeamBillingBalanceAction()).resolves.toEqual({
      errorCode: "tenant_scope_missing",
    });
    expect(mockBalanceByTenant).not.toHaveBeenCalled();
  });
});
