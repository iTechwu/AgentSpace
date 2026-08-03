import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { FeedbackToastProvider } from "@/shared/ui/feedback-toast-provider";
import { InstallSkillModal } from "./install-skill-modal";

const { approveSkill, createPlan, inspectSkill, listRuntimes } = vi.hoisted(() => ({
  approveSkill: vi.fn(async () => ({ approvalId: "approval-1" })),
  createPlan: vi.fn(async () => ({
    data: { installationId: "installation-1", status: "preparing" },
    toast: { tone: "info" as const, zh: "安装计划已创建。", en: "Installation planned." },
  })),
  inspectSkill: vi.fn(),
  listRuntimes: vi.fn(async () => [
    { id: "runtime-offline", name: "Offline", provider: "codex", status: "offline" },
    { id: "runtime-online", name: "Remote East", provider: "codex", status: "online" },
  ]),
}));

vi.mock("@/features/skills/installation-actions", () => ({
  approveSkillInstallAction: approveSkill,
  createSkillInstallationAction: createPlan,
  inspectSkillInstallationAction: inspectSkill,
  listSkillInstallableRuntimesAction: listRuntimes,
}));

const inspection = {
  artifact: {
    name: "document-renderer",
    version: "2.3.4",
    digest: "a".repeat(64),
    sourceType: "github",
    fileCount: 2,
    totalSizeBytes: 1200,
  },
  files: [
    { path: "SKILL.md", sizeBytes: 900, mediaType: "text/markdown", mode: "0644" },
    { path: "bin/render.py", sizeBytes: 300, mediaType: "text/x-python", mode: "0755" },
  ],
  dependencies: [{ kind: "pip", name: "pillow", version: "11.0.0" }],
  capabilities: [{ kind: "mcp", catalogSlug: "render", requiredTools: ["render_document"] }],
  services: [{ catalogSlug: "renderer", templateVersion: "2.0.0", required: true }],
  entrypoints: [{ id: "render", path: "bin/render.py", runtime: "python" }],
  components: [
    { kind: "dependency", key: "pip:pillow@11.0.0" },
    { kind: "script", key: "bin/render.py" },
  ],
  releaseLockDigest: "b".repeat(64),
  unresolvedRequired: [] as string[],
  riskItems: [] as Array<{ category: "script" | "network" | "mcp_tool" | "write"; key: string; description: string }>,
  riskDecisionDigest: "c".repeat(64),
};

function renderModal(onInstalled = vi.fn()) {
  render(
    <LanguageProvider>
      <FeedbackToastProvider>
        <InstallSkillModal onCancel={vi.fn()} onInstalled={onInstalled} skillId="skill-1" />
      </FeedbackToastProvider>
    </LanguageProvider>,
  );
  return onInstalled;
}

describe("InstallSkillModal", () => {
  beforeEach(() => {
    createPlan.mockClear();
    inspectSkill.mockReset();
    inspectSkill.mockResolvedValue(inspection);
    listRuntimes.mockClear();
  });

  it("reviews the immutable package and creates a plan on the selected online runtime", async () => {
    const user = userEvent.setup();
    const onInstalled = renderModal();

    expect(await screen.findByText("document-renderer · 2.3.4 · aaaaaaaaaaaa…")).toBeInTheDocument();
    expect(screen.getByText("bin/render.py")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("radio", { name: /Remote East/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("mcp:render · render_document")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("Release lock 已完整解析")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "创建安装计划" }));

    await waitFor(() => expect(createPlan).toHaveBeenCalledWith({ skillId: "skill-1", runtimeId: "runtime-online", approvalId: undefined }));
    await waitFor(() => expect(onInstalled).toHaveBeenCalled());
  });

  it("requires per-item authorization of every high-risk capability before creating the plan", async () => {
    const riskItems = [
      { category: "script" as const, key: "entrypoint:bin/render.py", description: "可执行脚本入口 bin/render.py（python）" },
      { category: "network" as const, key: "dependency:pip:pillow@11.0.0", description: "运行时安装依赖 pip:pillow@11.0.0 会访问软件源" },
    ];
    inspectSkill.mockResolvedValue({ ...inspection, riskItems });
    approveSkill.mockClear();
    const user = userEvent.setup();
    renderModal();

    await screen.findByText("document-renderer · 2.3.4 · aaaaaaaaaaaa…");

    // Reach the Access step (2) where per-item risk authorization lives.
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("高风险能力逐项授权")).toBeInTheDocument();

    // No per-item approval → the confirm step stays blocked.
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("button", { name: "创建安装计划" })).toBeDisabled();

    // Go back to the Access step and authorize only the FIRST risk item.
    await user.click(screen.getByRole("button", { name: "上一步" }));
    await user.click(screen.getByRole("button", { name: "上一步" }));
    await user.click(screen.getByRole("checkbox", { name: /entrypoint:bin\/render\.py/ }));

    // Still not all authorized → confirm stays blocked (no single global switch).
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByRole("button", { name: "创建安装计划" })).toBeDisabled();

    // Authorize the remaining item in the Access step.
    await user.click(screen.getByRole("button", { name: "上一步" }));
    await user.click(screen.getByRole("button", { name: "上一步" }));
    await user.click(screen.getByRole("checkbox", { name: /dependency:pip:pillow@11\.0\.0/ }));
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: "下一步" }));

    // Reason + create → approval recorded first, then the plan consumes it.
    await user.type(screen.getByPlaceholderText(/说明授权该 Skill 高风险能力的理由/), "团队已评审该渲染脚本");
    await user.click(screen.getByRole("button", { name: "创建安装计划" }));

    await waitFor(() =>
      expect(approveSkill).toHaveBeenCalledWith({ skillId: "skill-1", reason: "团队已评审该渲染脚本" }),
    );
    await waitFor(() =>
      expect(createPlan).toHaveBeenCalledWith({ skillId: "skill-1", runtimeId: "runtime-online", approvalId: "approval-1" }),
    );
  });

  it("blocks plan creation when required release-lock entries are unresolved", async () => {
    inspectSkill.mockResolvedValue({ ...inspection, unresolvedRequired: ["service:renderer"] });
    const user = userEvent.setup();
    renderModal();

    await screen.findByText("document-renderer · 2.3.4 · aaaaaaaaaaaa…");
    for (let index = 0; index < 4; index += 1) {
      await user.click(screen.getByRole("button", { name: "下一步" }));
    }
    expect(screen.getByRole("button", { name: "创建安装计划" })).toBeDisabled();
    expect(screen.getByText("必需能力未解析，不能创建安装计划。")).toBeInTheDocument();
    expect(createPlan).not.toHaveBeenCalled();
  });
});
