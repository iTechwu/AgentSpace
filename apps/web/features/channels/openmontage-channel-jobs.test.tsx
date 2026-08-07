import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { OpenMontageChannelJobs } from "@/features/channels/openmontage-channel-jobs";
import type { OpenMontageJobProjection } from "@dofe-agent/domain";

describe("OpenMontageChannelJobs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads persisted channel projections and refreshes them after an invalidation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ jobs: [projection({ status: "RUNNING" })] }))
      .mockResolvedValueOnce(Response.json({ jobs: [projection({ status: "SUCCEEDED", currentStage: null })] }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = renderJobs(0);

    expect(await screen.findByText("制作中")).toBeInTheDocument();
    rerender(wrapper(1));

    expect(await screen.findByText("已完成")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/workspaces/workspace-1/channels/video%20team/openmontage/jobs",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("submits card actions through AgentSpace and reloads the projection", async () => {
    const user = userEvent.setup();
    const waiting = projection({ status: "WAITING_APPROVAL" });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ jobs: [waiting] }))
      .mockResolvedValueOnce(Response.json({ accepted: true }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ jobs: [projection({ status: "RUNNING" })] }));
    vi.stubGlobal("fetch", fetchMock);
    renderJobs(0);

    await user.click(await screen.findByRole("button", { name: "批准并继续" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/workspaces/workspace-1/openmontage/jobs/om_job_1/actions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "approve", stage: "proposal", expectedSequence: 4 }),
      }),
    );
  });

  it("keeps the last trusted projection when a refresh fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ jobs: [projection({ status: "RUNNING" })] }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = renderJobs(0);
    expect(await screen.findByText("制作中")).toBeInTheDocument();

    rerender(wrapper(1));

    expect(await screen.findByRole("alert")).toHaveTextContent("视频任务状态暂时无法更新");
    expect(screen.getByText("制作中")).toBeInTheDocument();
  });
});

function renderJobs(refreshVersion: number) {
  return render(wrapper(refreshVersion));
}

function wrapper(refreshVersion: number) {
  return (
    <LanguageProvider initialLanguage="zh">
      <OpenMontageChannelJobs
        channelName="video team"
        refreshVersion={refreshVersion}
        workspaceId="workspace-1"
      />
    </LanguageProvider>
  );
}

function projection(overrides: Partial<OpenMontageJobProjection> = {}): OpenMontageJobProjection {
  const status = overrides.status ?? "RUNNING";
  return {
    schemaVersion: 1,
    jobId: "om_job_1",
    status,
    workflow: { name: "animated-explainer", version: "2.0" },
    stages: [
      {
        code: "proposal",
        labelCode: "openmontage.stage.proposal",
        approvalRequired: true,
        approvalStatus: status === "WAITING_APPROVAL" ? "PENDING" : "APPROVED",
        status: status === "WAITING_APPROVAL" ? "WAITING_APPROVAL" : "RUNNING",
        attempt: 1,
      },
    ],
    currentStage: "proposal",
    artifacts: [],
    lastAppliedSequence: 4,
    syncStatus: "CURRENT",
    nextExpectedSequence: 5,
    createdAt: "2026-08-05T10:00:00Z",
    updatedAt: "2026-08-05T10:00:04Z",
    ...overrides,
  };
}
