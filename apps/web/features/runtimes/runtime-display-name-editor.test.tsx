import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { updateWorkspaceRuntimeDisplayNameAction } from "@/features/agents/actions";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { RuntimeDisplayNameEditor } from "@/features/runtimes/runtime-display-name-editor";
import { FeedbackToastProvider } from "@/shared/ui/feedback-toast-provider";

const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

vi.mock("@/features/agents/actions", () => ({
  updateWorkspaceRuntimeDisplayNameAction: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function renderEditor(displayName?: string) {
  return render(
    <LanguageProvider initialLanguage="zh">
      <FeedbackToastProvider>
        <RuntimeDisplayNameEditor
          displayName={displayName}
          runtimeId="runtime-1"
          runtimeName="Managed codex 0806"
        />
      </FeedbackToastProvider>
    </LanguageProvider>,
  );
}

it("edits and saves the runtime display name inline", async () => {
  vi.mocked(updateWorkspaceRuntimeDisplayNameAction).mockResolvedValue({
    data: undefined,
    toast: { tone: "success", zh: "执行引擎名称已保存。", en: "Runtime name saved." },
  });
  const user = userEvent.setup();
  renderEditor("剪辑生产引擎");

  await user.click(screen.getByRole("button", { name: "编辑执行引擎名称" }));
  const input = screen.getByRole("textbox", { name: "执行引擎名称" });
  await user.clear(input);
  await user.type(input, "夜间渲染引擎");
  await user.click(screen.getByRole("button", { name: "保存名称" }));

  await waitFor(() => {
    expect(updateWorkspaceRuntimeDisplayNameAction).toHaveBeenCalledWith({
      runtimeId: "runtime-1",
      displayName: "夜间渲染引擎",
    });
  });
  expect(await screen.findByRole("heading", { name: "夜间渲染引擎" })).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("执行引擎名称已保存。");
  expect(refresh).toHaveBeenCalledOnce();
});

it("cancels editing with Escape and restores the saved name", async () => {
  const user = userEvent.setup();
  renderEditor("剪辑生产引擎");

  await user.click(screen.getByRole("button", { name: "编辑执行引擎名称" }));
  const input = screen.getByRole("textbox", { name: "执行引擎名称" });
  await user.clear(input);
  await user.type(input, "临时名称{Escape}");

  expect(screen.queryByRole("textbox", { name: "执行引擎名称" })).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "剪辑生产引擎" })).toBeInTheDocument();
  expect(updateWorkspaceRuntimeDisplayNameAction).not.toHaveBeenCalled();
});

it("keeps invalid or failed edits open with an inline error", async () => {
  const user = userEvent.setup();
  renderEditor();

  await user.click(screen.getByRole("button", { name: "编辑执行引擎名称" }));
  const input = screen.getByRole("textbox", { name: "执行引擎名称" });
  await user.clear(input);
  await user.click(screen.getByRole("button", { name: "保存名称" }));
  expect(screen.getByRole("alert")).toHaveTextContent("请输入执行引擎名称");

  vi.mocked(updateWorkspaceRuntimeDisplayNameAction).mockRejectedValue(new Error("暂时无法保存名称"));
  await user.type(input, "重命名失败");
  await user.click(screen.getByRole("button", { name: "保存名称" }));

  await waitFor(() => {
    const errorId = screen.getByRole("textbox", { name: "执行引擎名称" }).getAttribute("aria-describedby");
    expect(errorId ? document.getElementById(errorId) : null).toHaveTextContent("暂时无法保存名称");
  });
  expect(screen.getByRole("textbox", { name: "执行引擎名称" })).toHaveValue("重命名失败");
});
