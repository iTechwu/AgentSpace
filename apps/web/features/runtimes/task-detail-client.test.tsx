import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { RuntimeTaskDetailClient } from "@/features/runtimes/task-detail-client";
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

it("hides retry after the task reaches its retry limit", () => {
  render(
    <RuntimeTaskDetailClient
      workspaceSlug="acme"
      initialDetail={makeDetail(3, 3)}
    />,
  );

  expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
});

it("offers retry while the task remains below its retry limit", () => {
  render(
    <RuntimeTaskDetailClient
      workspaceSlug="acme"
      initialDetail={makeDetail(2, 3)}
    />,
  );

  expect(screen.getByRole("button", { name: "Retry (retry 3/3)" })).toBeInTheDocument();
});
