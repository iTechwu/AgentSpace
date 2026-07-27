import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgePageClient } from "@/features/knowledge/knowledge-page-client";
import { LanguageProvider } from "@/features/i18n/language-provider";
import type { KnowledgePageData } from "@/features/dashboard/data";

const {
  createKnowledgePageFromDocumentActionMock,
  updateKnowledgePageActionMock,
  routerRefreshMock,
  routerReplaceMock,
  searchParamsApi,
  searchParamsStore,
} = vi.hoisted(() => {
  const params = new URLSearchParams();
  return {
    createKnowledgePageFromDocumentActionMock: vi.fn(async () => "page-from-document"),
    updateKnowledgePageActionMock: vi.fn(async () => {}),
    routerRefreshMock: vi.fn(),
    routerReplaceMock: vi.fn(),
    searchParamsStore: params,
    searchParamsApi: {
      get: (key: string) => params.get(key),
      toString: () => params.toString(),
    },
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/workspace-alpha/knowledge",
  useRouter: () => ({
    refresh: routerRefreshMock,
    replace: routerReplaceMock,
  }),
  useSearchParams: () => searchParamsApi,
}));

vi.mock("@/features/knowledge/actions", () => ({
  createKnowledgePageAction: vi.fn(async () => {}),
  createKnowledgePageFromDocumentAction: createKnowledgePageFromDocumentActionMock,
  updateKnowledgePageAction: updateKnowledgePageActionMock,
  deleteKnowledgePageAction: vi.fn(async () => {}),
  materialToKnowledgePageAction: vi.fn(async () => {}),
  setKnowledgePageAssignmentsAction: vi.fn(async () => {}),
}));

vi.mock("@/features/channels/actions", () => ({
  createChannelDocumentFromAttachmentAction: vi.fn(async () => ({ documentId: "doc-1" })),
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

const data: KnowledgePageData = {
  pages: [
    {
      id: "page-1",
      parentId: null,
      title: "日本行程",
      contentMarkdown: "## 第一天\n大阪",
      sortOrder: 0,
      tags: ["travel"],
      createdBy: "techwu",
      createdAt: "2026-04-10T08:00:00.000Z",
      updatedAt: "2026-04-10T09:00:00.000Z",
      assignmentMode: "all_agents",
      assignedAgents: [],
      assignedAgentIds: [],
      assignedEmployeeNames: [],
      assignedAgentCount: 0,
      effectiveAgentCount: 1,
      assignmentSummary: "全员共享",
    },
  ],
  totalCount: 1,
  rootCount: 1,
  agentOptions: [
    {
      id: "agent:Planner",
      employeeName: "Planner",
      name: "Planner",
      subtitle: "Planner",
      status: "linked",
    },
  ],
  assignmentStats: {
    allAgentsPageCount: 1,
    selectedAgentsPageCount: 0,
    unconfiguredPageCount: 0,
  },
  materials: [],
  documentPages: [
    {
      id: "attachment:att-itinerary",
      sourceType: "attachment",
      sourceId: "att-itinerary",
      title: "itinerary.md",
      summary: "tour visit · techwu · text/markdown",
      previewText: "# Osaka Trip\n\nDay 1",
      fileName: "itinerary.md",
      mediaType: "text/markdown",
      sizeBytes: 1024,
      kind: "file",
      isMarkdown: true,
      channelName: "tour visit",
      sourceMessageId: "message-1",
      sourceSpeaker: "techwu",
      sourceTime: "2026-04-18T09:00:00.000Z",
      updatedAt: "2026-04-18T09:00:00.000Z",
      updatedBy: "techwu",
      status: "shared",
      linkedChannelDocuments: [],
      linkedKnowledgePages: [],
    },
  ],
  documentCount: 1,
  linkedDocumentCount: 0,
};

describe("KnowledgePageClient", () => {
  beforeEach(() => {
    mockMatchMedia(false);
    window.localStorage.clear();
    searchParamsStore.forEach((_, key) => searchParamsStore.delete(key));
    createKnowledgePageFromDocumentActionMock.mockClear();
    updateKnowledgePageActionMock.mockClear();
    routerRefreshMock.mockReset();
    routerReplaceMock.mockReset();
  });

  it("switches knowledge views from the page header", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider initialLanguage="zh">
        <KnowledgePageClient data={data} />
      </LanguageProvider>,
    );

    expect(screen.getByRole("tab", { name: "知识页面" })).toBeDisabled();
    await user.click(screen.getByRole("tab", { name: "文档页面" }));

    expect(routerReplaceMock).toHaveBeenCalledWith("/w/workspace-alpha/knowledge?view=documents");
    expect(screen.getByRole("tab", { name: "文档页面" })).toBeDisabled();
  });

  it("switches between page tree and detail on compact layouts", async () => {
    mockMatchMedia(true);
    const user = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <KnowledgePageClient data={data} />
      </LanguageProvider>,
    );

    expect(screen.getByRole("button", { name: "日本行程" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回列表" })).not.toBeInTheDocument();
    expect(screen.queryByText("创建者")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "日本行程" }));

    expect(await screen.findByRole("button", { name: "返回列表" })).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes("创建者") && content.includes("techwu"))).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes("## 第一天") && content.includes("大阪"))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回列表" }));

    expect(screen.getByRole("button", { name: "日本行程" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回列表" })).not.toBeInTheDocument();
  });

  it("switches to document pages and can create a knowledge page from a markdown document", async () => {
    const user = userEvent.setup();
    searchParamsStore.set("view", "documents");

    render(
      <LanguageProvider initialLanguage="zh">
        <KnowledgePageClient data={data} />
      </LanguageProvider>,
    );

    expect(screen.getByRole("heading", { name: "itinerary.md" })).toBeInTheDocument();
    expect(screen.getByText("共享附件")).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes("# Osaka Trip") && content.includes("Day 1"))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "沉淀为知识页面" }));
    expect(await screen.findByRole("heading", { name: "沉淀为知识页面" })).toBeInTheDocument();
    await user.click(screen.getByLabelText("指定 AI员工"));
    await user.click(screen.getByLabelText("Planner"));
    await user.click(screen.getByRole("button", { name: "创建知识页面" }));

    expect(createKnowledgePageFromDocumentActionMock).toHaveBeenCalledWith({
      sourceType: "attachment",
      sourceId: "att-itinerary",
      assignmentMode: "selected_agents",
      assignedEmployeeNames: ["Planner"],
    });
  });

  it("translates system document actors in English", () => {
    searchParamsStore.set("view", "documents");
    const systemData: KnowledgePageData = {
      ...data,
      pages: [
        {
          ...data.pages[0]!,
          createdBy: "系统提示",
        },
      ],
      documentPages: [
        {
          ...data.documentPages[0]!,
          sourceSpeaker: "系统提示",
          updatedBy: "系统提示",
        },
      ],
    };

    render(
      <LanguageProvider initialLanguage="en">
        <KnowledgePageClient data={systemData} />
      </LanguageProvider>,
    );

    expect(screen.getByText("#tour visit · System Notice · 04/18")).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes("Channel: #tour visit") && content.includes("Shared by: System Notice"))).toBeInTheDocument();
    expect(screen.queryByText("系统提示")).not.toBeInTheDocument();
  });

  it("uses module refresh callback after saving inside the workbench", async () => {
    const user = userEvent.setup();
    const onDataChanged = vi.fn();

    render(
      <LanguageProvider initialLanguage="zh">
        <KnowledgePageClient data={data} moduleSearchParams={new URLSearchParams()} onDataChanged={onDataChanged} />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "日本行程" }));
    await user.click(screen.getByRole("button", { name: /编辑|Edit/ }));
    await user.click(screen.getByRole("button", { name: /保存|Save/ }));

    expect(updateKnowledgePageActionMock).toHaveBeenCalledWith("page-1", expect.objectContaining({
      title: "日本行程",
    }));
    expect(onDataChanged).toHaveBeenCalledTimes(1);
    expect(routerRefreshMock).not.toHaveBeenCalled();
  });
});
