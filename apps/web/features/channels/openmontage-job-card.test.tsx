import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { OpenMontageJobCard } from "@/features/channels/openmontage-job-card";
import type { OpenMontageJobProjection } from "@dofe-agent/domain";

describe("OpenMontageJobCard", () => {
  it("shows the authoritative workflow stages, progress, usage, and artifacts", async () => {
    const user = userEvent.setup();
    renderCard(projection());

    const card = screen.getByRole("article", { name: "视频任务：animated-explainer" });
    expect(within(card).getByText("制作中")).toBeInTheDocument();
    expect(within(card).getByText("研究素材")).toBeInTheDocument();
    expect(within(card).getAllByText("生成制作方案")).toHaveLength(2);
    expect(within(card).getByRole("progressbar", { name: "生成制作方案进度" })).toHaveAttribute("aria-valuenow", "2");
    expect(within(card).getAllByText("2 / 5")).toHaveLength(2);

    await user.click(within(card).getByText("任务详情"));
    expect(within(card).getByText("模型实际消费")).toBeInTheDocument();
    expect(within(card).getByText("¥6.20")).toBeInTheDocument();
    expect(within(card).getByText("final.mp4")).toBeInTheDocument();
    expect(within(card).getByLabelText("最终视频预览")).toHaveAttribute(
      "src",
      "/api/workspaces/workspace-1/openmontage/jobs/om_job_1/artifacts/artifact-1",
    );
    expect(within(card).getByRole("link", { name: "下载视频" })).toHaveAttribute("download");
  });

  it("makes approval actions explicit and reports action failures without changing projection state", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn().mockRejectedValue(new Error("审批提交失败"));
    const waiting = projection({
      status: "WAITING_APPROVAL",
      currentStage: "proposal",
      stages: projection().stages.map((stage) => stage.code === "proposal"
        ? { ...stage, status: "WAITING_APPROVAL", approvalStatus: "PENDING" }
        : stage),
    });
    renderCard(waiting, onAction);

    await user.click(screen.getByRole("button", { name: "批准并继续" }));

    expect(onAction).toHaveBeenCalledWith({
      action: "approve",
      jobId: "om_job_1",
      stage: "proposal",
      expectedSequence: 4,
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("审批提交失败");
    expect(screen.getAllByText("等待审批").length).toBeGreaterThan(0);
  });

  it("shows syncing as an explicit state while retaining the last trusted stage", () => {
    renderCard(projection({ syncStatus: "SYNCING" }));

    expect(screen.getByText("正在同步最新进度")).toBeInTheDocument();
    expect(screen.getAllByText("生成制作方案").length).toBeGreaterThan(0);
  });
});

function renderCard(
  job: OpenMontageJobProjection,
  onAction?: React.ComponentProps<typeof OpenMontageJobCard>["onAction"],
) {
  return render(
    <LanguageProvider initialLanguage="zh">
      <OpenMontageJobCard job={job} onAction={onAction} workspaceId="workspace-1" />
    </LanguageProvider>,
  );
}

function projection(overrides: Partial<OpenMontageJobProjection> = {}): OpenMontageJobProjection {
  return {
    schemaVersion: 1,
    jobId: "om_job_1",
    status: "RUNNING",
    workflow: { name: "animated-explainer", version: "2.0" },
    stages: [
      {
        code: "research",
        labelCode: "openmontage.stage.research",
        approvalRequired: false,
        approvalStatus: "NOT_REQUIRED",
        status: "SUCCEEDED",
        attempt: 1,
        startedAt: "2026-08-05T10:00:01Z",
        completedAt: "2026-08-05T10:00:02Z",
      },
      {
        code: "proposal",
        labelCode: "openmontage.stage.proposal",
        approvalRequired: true,
        approvalStatus: "APPROVED",
        status: "RUNNING",
        attempt: 1,
        progress: { completedUnits: 2, totalUnits: 5, labelCode: "openmontage.progress.items" },
        startedAt: "2026-08-05T10:00:03Z",
      },
    ],
    currentStage: "proposal",
    usageSummary: { actualAmount: 6.2, currency: "CNY", reconciliationStatus: "RECONCILED" },
    artifacts: [{ artifactId: "artifact-1", fileName: "final.mp4", mediaType: "video/mp4", role: "final_video", status: "READY" }],
    lastAppliedSequence: 4,
    syncStatus: "CURRENT",
    nextExpectedSequence: 5,
    createdAt: "2026-08-05T10:00:00Z",
    updatedAt: "2026-08-05T10:00:04Z",
    ...overrides,
  };
}
