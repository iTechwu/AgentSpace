import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsPageClient } from "@/features/skills/skills-page-client";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { FeedbackToastProvider } from "@/shared/ui/feedback-toast-provider";
import type { SkillsPageData } from "@/features/dashboard/data";

const searchParams = new URLSearchParams();
const {
  mockCreateWorkspaceSkillAction,
  mockCheckWorkspaceSkillSourceUpdateAction,
  mockDeleteWorkspaceSkillAction,
  mockDeleteWorkspaceSkillFileAction,
  mockImportWorkspaceSkillFromZipAction,
  mockImportWorkspaceSkillFromServerDirectoryAction,
  mockImportWorkspaceSkillFromUrlAction,
  mockReimportWorkspaceSkillAction,
  mockUpdateWorkspaceSkillMetaAction,
  mockUpsertWorkspaceSkillFileAction,
} = vi.hoisted(() => ({
  mockCreateWorkspaceSkillAction: vi.fn(async () => ({
    data: { skillId: "skill-1", fileId: "file-1" },
    toast: { tone: "success", zh: "Skill 已创建。", en: "Skill created." },
  })),
  mockCheckWorkspaceSkillSourceUpdateAction: vi.fn(async () => ({
    data: {
      skillId: "skill-3",
      sourceType: "github",
      sourceUrl: "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack",
      status: "update_available" as const,
      currentResolvedRef: "abc123def456789012345678901234567890abcd",
      latestResolvedRef: "fedcba987654321001234567890123456789abcd",
    },
    toast: { tone: "info" as const, zh: "检测到新版本。", en: "A new version is available." },
  })),
  mockDeleteWorkspaceSkillAction: vi.fn(async () => ({
    data: undefined,
    toast: { tone: "success", zh: "Skill 已删除。", en: "Skill deleted." },
  })),
  mockDeleteWorkspaceSkillFileAction: vi.fn(async () => ({
    data: undefined,
    toast: { tone: "success", zh: "Skill 文件已删除。", en: "Skill file deleted." },
  })),
  mockImportWorkspaceSkillFromZipAction: vi.fn<(formData: FormData) => Promise<{
    data: { skillId: string; renamed: boolean; replaced: boolean; skipped: boolean };
    toast: { tone: "success"; zh: string; en: string };
  }>>(async () => ({
    data: { skillId: "skill-zip", renamed: false, replaced: false, skipped: false },
    toast: { tone: "success", zh: "Skill 已上传至 TOS 并导入。", en: "Skill uploaded to TOS and imported." },
  })),
  mockImportWorkspaceSkillFromServerDirectoryAction: vi.fn(async () => ({
    data: { skillId: "skill-local", renamed: false, replaced: false, skipped: false },
    toast: { tone: "success", zh: "已从服务器目录导入 Skill。", en: "Skill imported from the server directory." },
  })),
  mockImportWorkspaceSkillFromUrlAction: vi.fn(async () => ({
    data: { skillId: "skill-3", renamed: false, replaced: false, skipped: false },
    toast: { tone: "success", zh: "Skill 已导入。", en: "Skill imported." },
  })),
  mockReimportWorkspaceSkillAction: vi.fn(async () => ({
    data: { skillId: "skill-3" },
    toast: { tone: "info" as const, zh: "候选版本已生成。", en: "Candidate version created." },
  })),
  mockUpdateWorkspaceSkillMetaAction: vi.fn(async () => ({
    data: undefined,
    toast: { tone: "success", zh: "Skill 元数据已保存。", en: "Skill metadata saved." },
  })),
  mockUpsertWorkspaceSkillFileAction: vi.fn(async () => ({
    data: { fileId: "file-2" },
    toast: { tone: "success", zh: "Skill 文件已保存。", en: "Skill file saved." },
  })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => ({
    get: (key: string) => searchParams.get(key),
    toString: () => searchParams.toString(),
  }),
}));

vi.mock("@/features/skills/actions", () => ({
  checkWorkspaceSkillSourceUpdateAction: mockCheckWorkspaceSkillSourceUpdateAction,
  createWorkspaceSkillAction: mockCreateWorkspaceSkillAction,
  deleteWorkspaceSkillAction: mockDeleteWorkspaceSkillAction,
  deleteWorkspaceSkillFileAction: mockDeleteWorkspaceSkillFileAction,
  importWorkspaceSkillFromZipAction: mockImportWorkspaceSkillFromZipAction,
  importWorkspaceSkillFromServerDirectoryAction: mockImportWorkspaceSkillFromServerDirectoryAction,
  importWorkspaceSkillFromUrlAction: mockImportWorkspaceSkillFromUrlAction,
  reimportWorkspaceSkillAction: mockReimportWorkspaceSkillAction,
  updateWorkspaceSkillMetaAction: mockUpdateWorkspaceSkillMetaAction,
  upsertWorkspaceSkillFileAction: mockUpsertWorkspaceSkillFileAction,
}));

function mockMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches,
      media: "(max-width: 860px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const data: SkillsPageData = {
  skills: [
    {
      id: "skill-1",
      name: "workspace-context",
      isBuiltin: true,
      sourceType: "builtin",
      description: "Inspect workspace context",
      createdAt: "2026-04-10T08:00:00.000Z",
      updatedAt: "2026-04-10T09:00:00.000Z",
      files: [
        {
          id: "file-1",
          path: "SKILL.md",
          content: "# Workspace Context",
          createdAt: "2026-04-10T08:00:00.000Z",
          updatedAt: "2026-04-10T09:00:00.000Z",
        },
        {
          id: "file-2",
          path: "references/checklist.md",
          content: "- check context",
          createdAt: "2026-04-10T08:10:00.000Z",
          updatedAt: "2026-04-10T09:10:00.000Z",
        },
      ],
    },
    {
      id: "skill-2",
      name: "update-channel-documents",
      isBuiltin: true,
      sourceType: "builtin",
      description: "Update shared channel documents",
      createdAt: "2026-04-10T10:00:00.000Z",
      updatedAt: "2026-04-10T11:00:00.000Z",
      files: [
        {
          id: "file-4",
          path: "SKILL.md",
          content: "# Update Channel Documents",
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-10T11:00:00.000Z",
        },
      ],
    },
    {
      id: "skill-3",
      name: "research-pack",
      isBuiltin: false,
      sourceType: "github",
      sourceUrl: "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack",
      configJson: JSON.stringify({
        requirements: [
          { kind: "provider", value: "codex" },
          { kind: "capability", value: "tool_use" },
          { kind: "project", value: "repository" },
          { kind: "config", value: "API_BASE_URL" },
          { kind: "secret", value: "OPENAI_API_KEY" },
        ],
      }),
      description: "Research helper",
      createdAt: "2026-04-10T10:00:00.000Z",
      updatedAt: "2026-04-10T11:00:00.000Z",
      files: [
        {
          id: "file-3",
          path: "SKILL.md",
          content: "# Research Pack",
          createdAt: "2026-04-10T10:00:00.000Z",
          updatedAt: "2026-04-10T11:00:00.000Z",
        },
      ],
    },
    {
      id: "skill-4",
      name: "meeting-notes",
      isBuiltin: false,
      sourceType: "manual",
      description: "Meeting capture helper",
      createdAt: "2026-04-11T10:00:00.000Z",
      updatedAt: "2026-04-11T11:00:00.000Z",
      files: [
        {
          id: "file-5",
          path: "SKILL.md",
          content: "# Meeting Notes",
          createdAt: "2026-04-11T10:00:00.000Z",
          updatedAt: "2026-04-11T11:00:00.000Z",
        },
      ],
    },
  ],
  totalSkills: 4,
  assignedSkillCount: 4,
  recentImports: [
    {
      id: "import-1",
      skillId: "skill-3",
      skillName: "research-pack",
      sourceType: "github",
      sourceUrl: "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack",
      importMode: "created",
      importedAt: "2026-04-12T11:00:00.000Z",
      warnings: [],
    },
    {
      id: "import-2",
      skillId: "skill-missing",
      skillName: "archived-pack",
      sourceType: "clawhub",
      sourceUrl: "https://clawhub.ai/fangkelvin/find-skills-skill",
      importMode: "replaced",
      importedAt: "2026-04-13T11:00:00.000Z",
      warnings: ["Skipped non-text package asset"],
    },
  ],
  agents: [
    {
      id: "agent:atlas",
      name: "Atlas",
      internalName: "atlas",
      skillIds: ["skill-1", "skill-2", "skill-3", "skill-4"],
    },
  ],
};

function renderSkillsPage(): ReturnType<typeof render> {
  return render(
    <LanguageProvider>
      <FeedbackToastProvider>
        <SkillsPageClient data={data} />
      </FeedbackToastProvider>
    </LanguageProvider>,
  );
}

async function waitForOperationalPanels(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByText("正在加载升级候选…")).not.toBeInTheDocument();
    expect(screen.queryByText("正在加载支撑服务…")).not.toBeInTheDocument();
    expect(screen.queryByText("正在加载 SLO…")).not.toBeInTheDocument();
    expect(screen.queryByText("正在加载安装状态…")).not.toBeInTheDocument();
  });
}

describe("SkillsPageClient", () => {
  beforeEach(() => {
    mockMatchMedia(false);
    searchParams.forEach((_, key) => searchParams.delete(key));
    mockCreateWorkspaceSkillAction.mockClear();
    mockCheckWorkspaceSkillSourceUpdateAction.mockClear();
    mockDeleteWorkspaceSkillAction.mockClear();
    mockDeleteWorkspaceSkillFileAction.mockClear();
    mockImportWorkspaceSkillFromServerDirectoryAction.mockClear();
    mockImportWorkspaceSkillFromZipAction.mockClear();
    mockImportWorkspaceSkillFromUrlAction.mockClear();
    mockReimportWorkspaceSkillAction.mockClear();
    mockUpdateWorkspaceSkillMetaAction.mockClear();
    mockUpsertWorkspaceSkillFileAction.mockClear();
  });

  it("distinguishes builtin and general skills in the list", async () => {
    renderSkillsPage();

    expect(screen.getAllByText("系统默认技能").length).toBeGreaterThan(0);
    expect(screen.getByText("一般技能")).toBeInTheDocument();
    expect(screen.getAllByText("系统默认").length).toBeGreaterThan(0);
    expect(screen.getAllByText("GitHub").length).toBeGreaterThan(0);
    expect(screen.queryByText("Files")).not.toBeInTheDocument();
    await waitForOperationalPanels();
  });

  it("opens the import modal and submits the import request", async () => {
    const user = userEvent.setup();

    renderSkillsPage();

    await user.click(screen.getByRole("button", { name: "导入 Skill" }));

    expect(await screen.findByRole("heading", { name: "导入 Skill" })).toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "来源 URL" }),
      "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack",
    );
    await user.click(screen.getByRole("button", { name: "开始导入" }));

    expect(await screen.findByText("Skill 已导入。")).toBeInTheDocument();
  });

  it("normalizes marketplace import shortcuts before submitting", async () => {
    const user = userEvent.setup();

    renderSkillsPage();

    await user.click(screen.getByRole("button", { name: "导入 Skill" }));
    await user.click(screen.getByRole("button", { name: "选择 skills.sh 导入来源" }));
    await user.type(screen.getByRole("textbox", { name: "来源 URL" }), "apollographql/skills/skill-creator");
    await user.click(screen.getByRole("button", { name: "开始导入" }));

    expect(mockImportWorkspaceSkillFromUrlAction).toHaveBeenCalledWith({
      url: "https://skills.sh/apollographql/skills/skill-creator",
      conflict: "rename",
    });
  });

  it("submits GitLab skill URLs from the import modal", async () => {
    const user = userEvent.setup();

    renderSkillsPage();

    await user.click(screen.getByRole("button", { name: "导入 Skill" }));
    await user.click(screen.getByRole("button", { name: "选择 GitLab 导入来源" }));
    await user.type(
      screen.getByRole("textbox", { name: "来源 URL" }),
      "https://gitlab.com/octo-group/skill-repo/-/tree/main/skills/research-pack",
    );
    await user.click(screen.getByRole("button", { name: "开始导入" }));

    expect(mockImportWorkspaceSkillFromUrlAction).toHaveBeenCalledWith({
      url: "https://gitlab.com/octo-group/skill-repo/-/tree/main/skills/research-pack",
      conflict: "rename",
    });
  });

  it("normalizes ClawHub shorthand imports before submitting", async () => {
    const user = userEvent.setup();

    renderSkillsPage();

    await user.click(screen.getByRole("button", { name: "导入 Skill" }));
    await user.click(screen.getByRole("button", { name: "选择 ClawHub 导入来源" }));
    await user.type(screen.getByRole("textbox", { name: "来源 URL" }), "fangkelvin/find-skills-skill");
    await user.click(screen.getByRole("button", { name: "开始导入" }));

    expect(mockImportWorkspaceSkillFromUrlAction).toHaveBeenCalledWith({
      url: "https://clawhub.ai/fangkelvin/find-skills-skill",
      conflict: "rename",
    });
  });

  it("uploads a local zip for TOS-backed skill import", async () => {
    const user = userEvent.setup();

    renderSkillsPage();

    await user.click(screen.getByRole("button", { name: "导入 Skill" }));
    await user.click(screen.getByRole("button", { name: "选择 上传 ZIP 导入来源" }));
    const archive = new File(["zip-content"], "research-pack.zip", { type: "application/zip" });
    await user.upload(screen.getByLabelText("Skill 压缩包"), archive);
    await user.click(screen.getByRole("button", { name: "开始导入" }));

    await waitFor(() => {
      expect(mockImportWorkspaceSkillFromZipAction).toHaveBeenCalledTimes(1);
    });
    const formData = mockImportWorkspaceSkillFromZipAction.mock.calls[0]?.[0] as FormData;
    expect(formData.get("archive")).toBe(archive);
    expect(formData.get("conflict")).toBe("rename");
  });

  it("imports a skill from an administrator-approved server directory", async () => {
    const user = userEvent.setup();

    renderSkillsPage();

    await user.click(screen.getByRole("button", { name: "导入 Skill" }));
    await user.click(screen.getByRole("button", { name: "选择 服务器目录 导入来源" }));
    await user.type(screen.getByRole("textbox", { name: "服务器目录路径" }), "/srv/dofe-agent/skills/research-pack");
    await user.click(screen.getByRole("button", { name: "开始导入" }));

    expect(mockImportWorkspaceSkillFromServerDirectoryAction).toHaveBeenCalledWith({
      directoryPath: "/srv/dofe-agent/skills/research-pack",
      conflict: "rename",
    });
    expect(mockImportWorkspaceSkillFromUrlAction).not.toHaveBeenCalled();
  });

  it("filters skills by source type", async () => {
    const user = userEvent.setup();

    renderSkillsPage();

    expect(screen.getByRole("button", { name: /meeting-notes/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "GitHub" }));

    expect(screen.getAllByRole("button", { name: /research-pack/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /meeting-notes/i })).not.toBeInTheDocument();
  });

  it("keeps update inspection separate from candidate creation", async () => {
    const user = userEvent.setup();

    renderSkillsPage();
    await user.click(screen.getAllByRole("button", { name: /research-pack/i })[0]!);

    await user.click(screen.getByRole("button", { name: "检查更新" }));
    expect(mockCheckWorkspaceSkillSourceUpdateAction).toHaveBeenCalledWith("skill-3");
    expect(mockReimportWorkspaceSkillAction).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "获取候选版本" }));
    expect(mockReimportWorkspaceSkillAction).toHaveBeenCalledWith("skill-3");
  });

  it("shows source badges in the list without a separate import history panel", async () => {
    renderSkillsPage();

    expect(screen.queryByText("最近导入")).not.toBeInTheDocument();
    expect(screen.getAllByText("GitHub").length).toBeGreaterThan(0);
    expect(screen.getByText("工作区")).toBeInTheDocument();
    await waitForOperationalPanels();
  });

  it("switches between skill list and editor on compact layouts", async () => {
    mockMatchMedia(true);
    const user = userEvent.setup();

    renderSkillsPage();

    expect(screen.getByRole("button", { name: /workspace-context/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回技能列表" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存文件" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /workspace-context/i }));

    expect(await screen.findByRole("button", { name: "返回技能列表" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存 Skill" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "返回文件列表" })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("SKILL.md")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Workspace Context" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回技能列表" }));
    expect(screen.getByRole("button", { name: /workspace-context/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回技能列表" })).not.toBeInTheDocument();
  });

  it("opens the create-skill modal from query params", async () => {
    searchParams.set("create", "skill");

    renderSkillsPage();

    expect(await screen.findByRole("heading", { name: "创建 Skill" })).toBeInTheDocument();
  });

  it("imports a preset skill from the create skill marketplace", async () => {
    const user = userEvent.setup();

    renderSkillsPage();

    await user.click(screen.getByRole("button", { name: /添加技能|Add skill/i }));
    expect(await screen.findByRole("heading", { name: /创建 Skill|Create Skill/i })).toBeInTheDocument();
    expect(screen.getByText("财务分析智能体")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: /导入预设|Import preset/i })[0]!);

    await waitFor(() => {
      expect(mockImportWorkspaceSkillFromUrlAction).toHaveBeenCalledWith({
        url: "https://skills.sh/qodex-ai/ai-agent-skills/financial-analysis-agent",
        conflict: "rename",
      });
    });
  });

  it("imports a GitHub skill from the create-skill modal", async () => {
    const user = userEvent.setup();

    renderSkillsPage();

    await user.click(screen.getByRole("button", { name: /添加技能|Add skill/i }));
    await user.click(screen.getByRole("tab", { name: /GitHub 导入|GitHub Import/i }));
    await user.type(
      screen.getByRole("textbox", { name: "GitHub URL" }),
      "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack",
    );
    await user.selectOptions(screen.getByRole("combobox"), "replace");
    await user.click(screen.getByRole("button", { name: /从 GitHub 导入|Import from GitHub/i }));

    await waitFor(() => {
      expect(mockImportWorkspaceSkillFromUrlAction).toHaveBeenCalledWith({
        url: "https://github.com/octo-org/skill-repo/tree/main/skills/research-pack",
        conflict: "replace",
      });
    });
  });

  it("renders builtin skills as read-only in the editor", async () => {
    const user = userEvent.setup();

    renderSkillsPage();

    await user.click(screen.getByRole("button", { name: /workspace-context/i }));

    expect(screen.getByDisplayValue("workspace-context")).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Workspace Context" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除 Skill" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "只读预览" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存 Skill" })).toBeDisabled();
    expect(screen.queryByDisplayValue("Inspect workspace context")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新建 Skill 文件" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除文件" })).not.toBeInTheDocument();
  });

  it("keeps the imported skill editor focused on name content and assigned agents", async () => {
    const user = userEvent.setup();

    renderSkillsPage();

    await user.click(screen.getAllByRole("button", { name: /research-pack/i })[0]!);

    expect(screen.getByDisplayValue("research-pack")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Research Pack" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑 Markdown" })).toBeEnabled();
    expect(screen.getByText("Atlas")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除 Skill" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "保存 Skill" })).toBeDisabled();
    expect(screen.queryByText("类型：GitHub 导入")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "查看来源" })).not.toBeInTheDocument();
    expect(screen.queryByText(/删除后会自动解除 1 个 Agent 的绑定/)).not.toBeInTheDocument();
    expect(screen.queryByText("选择当前筛选结果")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /批量删除/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /批量导出/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /批量重新导入/i })).not.toBeInTheDocument();
  });

});
