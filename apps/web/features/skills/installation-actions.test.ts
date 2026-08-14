import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertWorkspaceRole: vi.fn(),
  buildComponents: vi.fn(() => []),
  buildRiskItems: vi.fn(() => []),
  computeReleaseLock: vi.fn(() => ({ lockDigest: "lock-digest", unresolvedRequired: [] })),
  computeRiskDigest: vi.fn(() => "risk-digest"),
  migrateLegacySkills: vi.fn(),
  readActiveDigest: vi.fn(),
  readArtifact: vi.fn(),
  readArtifactFiles: vi.fn(() => []),
  requireWorkspaceContext: vi.fn(),
}));

vi.mock("@dofe-agent/db", () => ({
  readActiveArtifactDigestForSkillSync: mocks.readActiveDigest,
  readSkillArtifactByDigestSync: mocks.readArtifact,
  readSkillArtifactFilesSync: mocks.readArtifactFiles,
}));

vi.mock("@dofe-agent/services", () => ({
  buildSkillInstallationComponentsSync: mocks.buildComponents,
  buildSkillInstallRiskItemsSync: mocks.buildRiskItems,
  computeSkillInstallRiskDecisionDigestSync: mocks.computeRiskDigest,
  computeSkillReleaseLockSync: mocks.computeReleaseLock,
  migrateLegacySkillArtifactsSync: mocks.migrateLegacySkills,
}));

vi.mock("@/features/auth/server-workspace", () => ({
  requireCurrentWorkspaceContext: mocks.requireWorkspaceContext,
}));

vi.mock("@/features/auth/workspace-permissions", () => ({
  assertWorkspaceRoleForContext: mocks.assertWorkspaceRole,
}));

vi.mock("@/features/auth/workspace-revalidation", () => ({
  revalidateWorkspacePaths: vi.fn(),
}));

vi.mock("@/features/skills/skill-installation-diagnostics", () => ({
  buildSkillInstallationDiagnostics: vi.fn(),
}));

import { inspectSkillInstallationAction } from "./installation-actions";

describe("skill installation actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkspaceContext.mockResolvedValue({
      currentUser: { id: "user-1", displayName: "Admin" },
      currentWorkspace: { id: "workspace-1", slug: "workspace" },
    });
    mocks.readActiveDigest
      .mockReturnValueOnce(undefined)
      .mockReturnValue("a".repeat(64));
    mocks.readArtifact.mockReturnValue({
      id: "artifact-1",
      workspaceId: "workspace-1",
      digest: "a".repeat(64),
      name: "legacy-skill",
      version: "1.0.0",
      manifestJson: "{}",
      sourceType: "legacy",
      fileCount: 1,
      totalSizeBytes: 128,
    });
  });

  it("migrates the selected legacy skill on demand before installation inspection", async () => {
    await expect(inspectSkillInstallationAction({ skillId: " legacy-skill-id " })).resolves.toMatchObject({
      artifact: { digest: "a".repeat(64), name: "legacy-skill" },
    });

    expect(mocks.migrateLegacySkills).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      skillId: "legacy-skill-id",
      limit: 1,
    });
    expect(mocks.readActiveDigest).toHaveBeenCalledTimes(2);
  });

  it("keeps the missing artifact error when targeted migration cannot create a digest", async () => {
    mocks.readActiveDigest.mockReset();
    mocks.readActiveDigest.mockReturnValue(undefined);

    await expect(inspectSkillInstallationAction({ skillId: "legacy-skill-id" })).rejects.toThrow(
      "此 Skill 尚无不可变 artifact，请先重新导入以生成 artifact。",
    );

    expect(mocks.migrateLegacySkills).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      skillId: "legacy-skill-id",
      limit: 1,
    });
    expect(mocks.readActiveDigest).toHaveBeenCalledTimes(2);
  });

  it("skips migration when the skill already has an active artifact", async () => {
    mocks.readActiveDigest.mockReset();
    mocks.readActiveDigest.mockReturnValue("a".repeat(64));

    await expect(inspectSkillInstallationAction({ skillId: "legacy-skill-id" })).resolves.toMatchObject({
      artifact: { digest: "a".repeat(64) },
    });

    expect(mocks.migrateLegacySkills).not.toHaveBeenCalled();
    expect(mocks.readActiveDigest).toHaveBeenCalledTimes(1);
  });
});
