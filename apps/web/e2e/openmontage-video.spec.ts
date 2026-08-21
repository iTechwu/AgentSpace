import { expect, test } from "@playwright/test";
import { openSeededWorkspacePage } from "./helpers";

test("video job lifecycle renders progress, approval, preview, and download", async ({ page }) => {
  let projectionReads = 0;
  let actionRequests = 0;
  const artifactBytes = Buffer.from("synthetic-mp4-payload");
  const completedProjection = projection("SUCCEEDED", {
    artifacts: [{
      artifactId: "artifact-final-video",
      fileName: "final.mp4",
      mediaType: "video/mp4",
      status: "PUBLISHED",
      sha256: "a".repeat(64),
      sizeBytes: artifactBytes.byteLength,
      role: "final_video",
    }],
    currentStage: null,
    lastAppliedSequence: 6,
  });

  await page.route("**/api/workspaces/*/channels/*/openmontage/jobs", async (route) => {
    projectionReads += 1;
    const current = projectionReads === 1
      ? projection("WAITING_APPROVAL")
      : actionRequests > 0 && projectionReads === 2
        ? projection("RUNNING", { lastAppliedSequence: 5 })
        : completedProjection;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobs: [{ ...current, conversationId: "e2e-conversation" }] }),
    });
  });
  await page.route("**/api/workspaces/*/openmontage/jobs/*/actions", async (route) => {
    actionRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toMatchObject({
      action: "approve",
      stage: "compose",
      expectedSequence: 4,
    });
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ accepted: true }) });
  });
  await page.route("**/api/workspaces/*/openmontage/jobs/*/artifacts/*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "video/mp4",
      headers: {
        "Content-Disposition": route.request().url().includes("download=1") ? "attachment; filename=final.mp4" : "inline",
        "Content-Length": String(artifactBytes.byteLength),
      },
      body: artifactBytes,
    });
  });

  await openSeededWorkspacePage(page, "/im");
  const job = page.getByRole("article", { name: /视频任务|Video job/i });
  await expect(job).toBeVisible();
  await expect(job.getByText("等待审批").first()).toBeVisible();

  await job.getByRole("button", { name: "批准并继续" }).click();
  await expect(job.getByText("制作中")).toBeVisible();

  await page.reload();
  await expect(job.getByText("已完成").first()).toBeVisible();
  await job.getByText("任务详情").click();
  await expect(job.locator('video[aria-label="最终视频预览"]')).toBeVisible();
  const download = job.getByRole("link", { name: "下载视频" });
  await expect(download).toHaveAttribute("download", "");
  const downloadResult = await page.evaluate(async (href) => {
    const response = await fetch(href);
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: Array.from(new Uint8Array(await response.arrayBuffer())),
    };
  }, await download.getAttribute("href") ?? "");
  expect(downloadResult.status).toBe(200);
  expect(downloadResult.contentType).toBe("video/mp4");
  expect(Buffer.from(downloadResult.body)).toEqual(artifactBytes);
  await page.screenshot({ path: "test-results/openmontage-video-lifecycle.png", fullPage: true });
});

test("video job action exposes a video service outage", async ({ page }) => {
  await page.route("**/api/workspaces/*/channels/*/openmontage/jobs", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobs: [{ ...projection("WAITING_APPROVAL"), conversationId: "e2e-conversation" }] }),
    });
  });
  await page.route("**/api/workspaces/*/openmontage/jobs/*/actions", async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "openmontage_unavailable" }),
    });
  });
  await openSeededWorkspacePage(page, "/im");
  const job = page.getByRole("article", { name: /视频任务|Video job/i });
  await job.getByRole("button", { name: "批准并继续" }).click();
  await expect(job.getByRole("alert")).toContainText("视频服务尚未配置完成");
  await expect(job.getByText("等待审批").first()).toBeVisible();
});

function projection(status: "WAITING_APPROVAL" | "RUNNING" | "SUCCEEDED", overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    jobId: "om_job_e2e_video",
    status,
    workflow: { name: "deterministic-video-smoke", version: "1.0" },
    stages: [{
      code: "compose",
      labelCode: "openmontage.stage.compose",
      approvalRequired: true,
      approvalStatus: status === "WAITING_APPROVAL" ? "REQUIRED" : "APPROVED",
      status: status === "WAITING_APPROVAL" ? "WAITING_APPROVAL" : "SUCCEEDED",
      attempt: 1,
    }],
    currentStage: status === "SUCCEEDED" ? null : "compose",
    artifacts: [],
    lastAppliedSequence: status === "WAITING_APPROVAL" ? 4 : 5,
    syncStatus: "CURRENT",
    nextExpectedSequence: status === "WAITING_APPROVAL" ? 5 : 6,
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-21T10:00:04.000Z",
    ...overrides,
  };
}
