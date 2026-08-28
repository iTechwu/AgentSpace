import { describe, expect, it, vi } from "vitest";
import {
  actionToastResult,
  runToastAction,
  successToast,
} from "@/shared/lib/toast-action";
import type { WorkspaceInvalidationEvent } from "@/features/dashboard/workspace-invalidation";

describe("toast action helpers", () => {
  it("passes the full action result to success callbacks", async () => {
    const onSuccess = vi.fn();
    const pushToast = vi.fn(() => "toast-1");
    const invalidation: WorkspaceInvalidationEvent = {
      workspaceId: "workspace-1",
      modules: ["task-board"],
      resources: [{ type: "task", id: "task-1" }],
      shell: "counters",
    };

    const result = actionToastResult(
      { taskId: "task-1" },
      successToast("已更新", "Updated"),
      invalidation,
    );

    await runToastAction({
      action: async () => result,
      onSuccess,
      pushToast,
      tx: (_zh, en) => en,
    });

    expect(pushToast).toHaveBeenCalledWith({
      message: "Updated",
      tone: "success",
    });
    expect(onSuccess).toHaveBeenCalledWith({ taskId: "task-1" }, result);
  });
});
