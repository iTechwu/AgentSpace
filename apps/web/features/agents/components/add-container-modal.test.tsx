import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { AddContainerModal } from "./add-container-modal";

describe("AddContainerModal", () => {
  it("renders onboarding steps and daemon identifiers", () => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {}),
      },
    });

    render(
      <LanguageProvider initialLanguage="zh">
        <AddContainerModal
          command={"bash install.sh"}
          daemonId="daemon-abc"
          daemonTokenId="token-xyz"
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      </LanguageProvider>,
    );

    expect(screen.getByRole("dialog", { name: "接入服务器" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "接入服务器" })).toBeInTheDocument();
    expect(screen.getByText("约 2 分钟完成接入，当前页面会检测服务器上线状态。")).toBeInTheDocument();
    expect(screen.getByText("在目标 Linux 或 macOS 服务器的终端中执行。")).toBeInTheDocument();
    expect(screen.getByText("daemon-abc")).toBeInTheDocument();
    expect(screen.getByText("token-xyz")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始检测" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭弹窗" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制命令" })).toBeInTheDocument();
  });

  it("shows actionable feedback when copying fails", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () => {
          throw new Error("Permission denied");
        }),
      },
    });

    render(
      <LanguageProvider initialLanguage="zh">
        <AddContainerModal
          command="bash install.sh"
          daemonId="daemon-abc"
          daemonTokenId="token-xyz"
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "复制命令" }));

    expect(screen.getByRole("alert")).toHaveTextContent("复制失败，请检查浏览器剪贴板权限后重试。");
    expect(screen.getByRole("button", { name: "复制命令" })).toBeEnabled();
  });

  it("marks server detection as busy and announces the waiting state", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));

    render(
      <LanguageProvider initialLanguage="zh">
        <AddContainerModal
          command="bash install.sh"
          daemonId="daemon-abc"
          daemonTokenId="token-xyz"
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "复制命令" }));
    const confirmButton = screen.getByRole("button", { name: "开始检测" });
    await user.click(confirmButton);

    expect(screen.getByRole("button", { name: "正在检测..." })).toBeDisabled();
    expect(screen.getByRole("button", { name: "正在检测..." })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("正在等待服务器上线。");
    expect(screen.getByRole("status")).toHaveClass("feedback-banner--info");
  });
});
