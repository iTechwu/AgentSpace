import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { FeedbackToastProvider } from "@/shared/ui/feedback-toast-provider";
import { SkillInstallationPanel } from "./skill-installation-panel";

const { createUpgrade, listRows } = vi.hoisted(() => ({
  createUpgrade: vi.fn(async () => ({
    data: { installationId: "candidate-installation", breaking: true, changeCount: 3 },
    toast: { tone: "info" as const, zh: "升级计划已创建。", en: "Upgrade planned." },
  })),
  listRows: vi.fn(),
}));

vi.mock("@/features/skills/installation-actions", () => ({
  createSkillUpgradeAction: createUpgrade,
  listSkillInstallationRowsForSkillAction: listRows,
  promoteSkillUpgradeAction: vi.fn(),
  rollbackSkillInstallationAction: vi.fn(),
  uninstallSkillInstallationAction: vi.fn(),
}));

const activeRow = {
  installationId: "installation-v1",
  runtimeId: "runtime-east",
  artifactDigest: "a".repeat(64),
  status: "ready",
  revision: "v1",
  active: true,
  releaseLockDigest: "b".repeat(64),
  preparedDigest: "a".repeat(64),
  health: "healthy",
  createdAt: "2026-08-03T00:00:00.000Z",
  candidateArtifactDigest: "c".repeat(64),
  candidateBreaking: true,
  candidateChangeCount: 3,
  components: [],
  operations: [],
};

describe("SkillInstallationPanel", () => {
  beforeEach(() => {
    createUpgrade.mockClear();
    listRows.mockReset();
    listRows.mockResolvedValue([activeRow]);
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("creates an explicitly approved upgrade plan for a breaking candidate", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <SkillInstallationPanel skillId="skill-1" />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(await screen.findByText(/3 项变更 · 破坏性/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "准备升级" }));

    await waitFor(() => expect(createUpgrade).toHaveBeenCalledWith({
      skillId: "skill-1",
      runtimeId: "runtime-east",
      previousInstallationId: "installation-v1",
      candidateArtifactDigest: "c".repeat(64),
      approved: true,
    }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("breaking"));
  });
});
