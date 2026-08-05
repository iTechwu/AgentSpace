import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { FeedbackToastProvider } from "@/shared/ui/feedback-toast-provider";
import { SkillInstallationPanel } from "./skill-installation-panel";

const { createUpgrade, downloadDiagnostics, loadPanel } = vi.hoisted(() => ({
  createUpgrade: vi.fn(async () => ({
    data: { installationId: "candidate-installation", breaking: true, changeCount: 3 },
    toast: { tone: "info" as const, zh: "升级计划已创建。", en: "Upgrade planned." },
  })),
  downloadDiagnostics: vi.fn(async () => ({
    data: { fileName: "skill-diagnostics.json", contentBase64: "e30=", sha256: "a".repeat(64) },
    toast: { tone: "success" as const, zh: "脱敏诊断包已生成。", en: "Redacted diagnostics generated." },
  })),
  loadPanel: vi.fn(),
}));

vi.mock("@/features/skills/installation-actions", () => ({
  createSkillUpgradeAction: createUpgrade,
  downloadSkillInstallationDiagnosticsAction: downloadDiagnostics,
  loadSkillInstallationPanelAction: loadPanel,
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
    downloadDiagnostics.mockClear();
    loadPanel.mockReset();
    loadPanel.mockResolvedValue({ rows: [activeRow], approvals: [], invocations: [] });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:diagnostics") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
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
      approvedRisks: false,
    }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("breaking"));
  });

  it("downloads the redacted installation diagnostics", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <SkillInstallationPanel skillId="skill-1" />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "下载脱敏诊断包" }));

    await waitFor(() => expect(downloadDiagnostics).toHaveBeenCalledWith({ skillId: "skill-1" }));
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:diagnostics");
  });

  it("renders duplicate risk item keys without a React key warning", async () => {
    loadPanel.mockResolvedValue({
      rows: [activeRow],
      approvals: [{
        id: "approval-1",
        skillId: "skill-1",
        artifactDigest: "d".repeat(64),
        releaseLockDigest: "e".repeat(64),
        policyVersion: "v1",
        riskDecisionDigest: "f".repeat(64),
        decision: "approved",
        riskItems: [
          { category: "script", key: "skill_artifact_verification_failure", description: "Script verification failed." },
          { category: "network", key: "skill_artifact_verification_failure", description: "Network verification failed." },
        ],
        reason: "QA approval",
        createdAt: "2026-08-05T00:00:00.000Z",
      }],
      invocations: [],
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <LanguageProvider initialLanguage="zh">
        <FeedbackToastProvider>
          <SkillInstallationPanel skillId="skill-1" />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(await screen.findByText("审批记录（1）")).toBeInTheDocument();
    expect(screen.getAllByText("skill_artifact_verification_failure")).toHaveLength(2);
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
    consoleError.mockRestore();
  });
});
