import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RuntimeTaskDetailClient } from "@/features/runtimes/task-detail-client";
import { LanguageProvider } from "@/features/i18n/language-provider";
import type { RuntimeProvisioningTaskDetail } from "@dofe-agent/services";

vi.mock("@/features/runtimes/actions", () => ({
  cancelProvisioningAction: vi.fn(),
  getProvisioningTaskAction: vi.fn(),
  retryProvisioningAction: vi.fn(),
}));

function makeDetail(retryCount: number, maxRetries: number): RuntimeProvisioningTaskDetail {
  return {
    task: {
      id: "task-failed",
      workspaceId: "workspace-1",
      requestedByUserId: "user-1",
      idempotencyKey: "test-task-failed",
      runtimeType: "claude",
      protocols: ["anthropic"],
      requestedName: "Claude Runtime",
      allowedModels: [],
      status: "failed",
      stage: "request_credential",
      stageStatus: "failed",
      progressPercent: 20,
      retryCount,
      maxRetries,
      cleanupStatus: "pending",
      credentialConfigured: false,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:01:00.000Z",
      completedAt: "2026-07-28T00:01:00.000Z",
    },
    events: [],
  } as RuntimeProvisioningTaskDetail;
}

function renderTaskDetail(detail: RuntimeProvisioningTaskDetail) {
  return render(
    <LanguageProvider initialLanguage="zh">
      <RuntimeTaskDetailClient workspaceSlug="acme" initialDetail={detail} />
    </LanguageProvider>,
  );
}

it("hides retry after the task reaches its retry limit", () => {
  renderTaskDetail(makeDetail(3, 3));

  expect(screen.queryByRole("button", { name: /重试/ })).not.toBeInTheDocument();
});

it("offers retry while the task remains below its retry limit", () => {
  renderTaskDetail(makeDetail(2, 3));

  expect(screen.getByRole("button", { name: "重试（第 3/3 次）" })).toBeInTheDocument();
});

it("uses the runtime detail layout classes instead of uncompiled utility classes", () => {
  renderTaskDetail(makeDetail(0, 3));

  expect(screen.getByRole("heading", { name: "Claude Code 部署" }).closest("section"))
    .toHaveClass("runtime-task-detail");
  expect(screen.getByLabelText("部署进度")).toHaveClass("runtime-task-detail__progress");
});

it("renders runtime provisioning details in Chinese", () => {
  const detail = makeDetail(1, 3);
  detail.task.status = "retrying";
  detail.task.stage = "pull_image";
  detail.task.stageStatus = "running";
  detail.task.runtimeCredentialId = "credential-123456";
  detail.task.lastErrorMessage = "docker pull failed";
  detail.events = [{
    id: "event-1",
    taskId: detail.task.id,
    stage: "pull_image",
    status: "failed",
    progressPercent: 50,
    title: "Image pull failed",
    summary: "docker pull failed",
    severity: "error",
    createdAt: "2026-07-28T00:00:00.000Z",
  }];

  renderTaskDetail(detail);

  expect(screen.getAllByText("拉取镜像")).toHaveLength(2);
  expect(screen.getByText("状态：重试中")).toBeInTheDocument();
  expect(screen.getByText("错误：docker pull failed")).toBeInTheDocument();
  expect(screen.getByText("阶段日志")).toBeInTheDocument();
});
