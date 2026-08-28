import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { DataProtectionSloPanel } from "./data-protection-slo-panel";

const { readDashboard } = vi.hoisted(() => ({
  readDashboard: vi.fn(),
}));

vi.mock("@/features/skills/slo-actions", () => ({
  readDataProtectionSloDashboardAction: readDashboard,
}));

describe("DataProtectionSloPanel", () => {
  beforeEach(() => {
    readDashboard.mockReset();
    readDashboard.mockResolvedValue({
      metrics: {
        workspaceHeadAgeSeconds: 0,
        skillArtifactVerificationFailures: 2,
        runtimeBindingGenerationConflicts: 0,
        taskCommitReconciliationBacklog: 0,
        runtimeRecoveryDurationSeconds: 0,
        employeeDataUsageBytes: 0,
        retentionQuotaExceededEmployees: 0,
        activeLegalHolds: 0,
      },
      alerts: [
        { code: "skill_artifact_verification_failure", severity: "error", message: "Artifact A failed." },
        { code: "skill_artifact_verification_failure", severity: "error", message: "Artifact B failed." },
      ],
      checkedAt: "2026-08-05T00:00:00.000Z",
      sloTargets: { headAgeSeconds: 604800, recoveryRtoSeconds: 3600 },
    });
  });

  it("renders repeated alert codes without a React key warning", async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <LanguageProvider initialLanguage="zh">
        <DataProtectionSloPanel />
      </LanguageProvider>,
    );

    expect(readDashboard).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "加载数据保护 SLO" }));

    expect(await screen.findByText("Artifact A failed.")).toBeInTheDocument();
    expect(screen.getByText("Artifact B failed.")).toBeInTheDocument();
    expect(screen.getAllByText("skill_artifact_verification_failure")).toHaveLength(2);
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
    consoleError.mockRestore();
  });
});
