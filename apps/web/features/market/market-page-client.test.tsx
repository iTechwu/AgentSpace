import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { MarketPageClient, type MarketPageData } from "@/features/market/market-page-client";
import { FeedbackToastProvider } from "@/shared/ui/feedback-toast-provider";

const mockRefresh = vi.fn();
const navigationMocks = vi.hoisted(() => ({
  push: vi.fn(),
  searchParams: new URLSearchParams(),
  workspaceSlug: "default",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mockRefresh,
    replace: vi.fn(),
    push: navigationMocks.push,
  }),
  useSearchParams: () => navigationMocks.searchParams,
  useParams: () => ({ workspaceSlug: navigationMocks.workspaceSlug }),
}));

const actionMocks = vi.hoisted(() => ({
  createMcpCatalogItem: vi.fn(async () => ({ data: undefined })),
  refreshCatalog: vi.fn(async () => ({ data: undefined })),
  requestOperation: vi.fn(async () => ({ data: undefined })),
  requestMcpConnection: vi.fn(async () => ({ data: undefined })),
  replaceMcpConnectionConfig: vi.fn(async () => ({ data: undefined })),
  rotateMcpSecret: vi.fn(async () => ({ data: undefined })),
  syncSkill: vi.fn(async () => ({ data: undefined })),
}));

vi.mock("@/features/market/actions", () => ({
  refreshRuntimeAppCatalogAction: actionMocks.refreshCatalog,
  requestRuntimeAppOperationAction: actionMocks.requestOperation,
  syncRuntimeAppSkillAction: actionMocks.syncSkill,
}));

vi.mock("@/features/market/mcp-actions", () => ({
  createMcpCatalogItemAction: actionMocks.createMcpCatalogItem,
  disableMcpConnectionAction: vi.fn(async () => ({ data: undefined })),
  enableMcpConnectionAction: vi.fn(async () => ({ data: undefined })),
  removeMcpConnectionAction: vi.fn(async () => ({ data: undefined })),
  requestMcpConnectionAction: actionMocks.requestMcpConnection,
  reverifyMcpConnectionAction: vi.fn(async () => ({ data: undefined })),
  replaceMcpConnectionConfigAction: actionMocks.replaceMcpConnectionConfig,
  rotateMcpSecretAction: actionMocks.rotateMcpSecret,
}));

const data: MarketPageData = {
  catalog: [
    {
      source: "clihub_harness",
      productSource: "clihub_harness",
      name: "mermaid",
      displayName: "Mermaid",
      description: "Render diagrams",
      version: "1.0.0",
      category: "diagram",
      entryPoint: "mmdc",
      installStrategy: "cli_hub",
      risk: "low",
      installability: {
        status: "installable",
        requiredTools: ["cli_hub"],
      },
    },
  ],
  catalogHealth: {
    itemCount: 1,
    lastSyncedAt: "2026-05-08T00:00:00.000Z",
    stale: false,
  },
  runtimes: [
    {
      id: "runtime-online",
      label: "Online Runtime",
      provider: "codex",
      status: "online",
      daemonKey: "daemon-online",
      cliHubReady: true,
      cliReadiness: { npm: true, python: true, pip: true, cliHub: true },
      mcpEligible: true,
    },
    {
      id: "runtime-offline",
      label: "Offline Runtime",
      provider: "codex",
      status: "offline",
      daemonKey: "daemon-offline",
      cliHubReady: false,
      cliReadiness: { npm: false, python: false, pip: false, cliHub: false },
      mcpEligible: false,
    },
  ],
  installedApps: [],
  operations: [],
  mcpCatalog: [
    {
      id: "mcp-catalog-1",
      source: "workspace_private",
      slug: "workspace-search",
      displayName: "Workspace Search",
      description: "Search workspace records",
      version: "1.0.0",
      category: "productivity",
      transport: "streamable_http",
      risk: "low",
      allowedHosts: ["mcp.example.com"],
      dataDomains: ["workspace"],
      declaredTools: [{ name: "search", description: "Search records", risk: "low" }],
      defaultApprovedTools: ["search"],
      secretFields: ["Authorization"],
      configurationFields: [{ name: "X-Workspace", required: true, maxLength: 64 }],
      endpointTemplate: "https://mcp.example.com/mcp",
    },
  ],
  mcpConnections: [],
  mcpOperations: [],
  canManage: true,
};

describe("MarketPageClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    mockRefresh.mockClear();
    navigationMocks.push.mockClear();
    navigationMocks.searchParams = new URLSearchParams();
    actionMocks.refreshCatalog.mockClear();
    actionMocks.createMcpCatalogItem.mockClear();
    actionMocks.requestOperation.mockClear();
    actionMocks.requestMcpConnection.mockClear();
    actionMocks.rotateMcpSecret.mockClear();
    actionMocks.syncSkill.mockClear();
    actionMocks.replaceMcpConnectionConfig.mockClear();
    window.localStorage.removeItem("dofe-agent-language");
  });

  it("presents CLI apps and MCP services as one capability market", () => {
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={data} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByRole("heading", { name: "应用与服务市场" })).toBeInTheDocument();
    expect(screen.getByLabelText("市场概览")).toHaveTextContent("可用能力2");
    expect(screen.getByRole("tab", { name: "CLI 市场" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "MCP 市场" })).toHaveTextContent("1 个目录服务");
  });

  it("uses one intentional empty state when the MCP catalog is unavailable", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={{ ...data, mcpCatalog: [] }} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "MCP 市场" }));

    expect(screen.getByRole("heading", { name: "MCP 服务目录为空" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "搜索 MCP 服务" })).not.toBeInTheDocument();
    expect(screen.queryByText("暂无 MCP 服务。")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加第一个服务" })).toBeInTheDocument();
  });

  it("publishes a workspace-private MCP release from the market", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={data} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "MCP 市场" }));
    await user.click(screen.getByRole("button", { name: "添加 MCP 服务" }));
    const dialog = screen.getByRole("dialog", { name: "添加 MCP 服务" });
    const catalogForm = within(dialog);
    await user.type(catalogForm.getByLabelText("服务名称", { selector: "input" }), "Internal Search");
    await user.type(catalogForm.getByLabelText("Endpoint (HTTPS)"), "https://mcp.internal.example/mcp");
    await user.type(catalogForm.getByLabelText("工具 1"), "search_records");
    await user.type(catalogForm.getByLabelText("说明", { selector: "input" }), "Search internal records");
    await user.click(catalogForm.getByRole("button", { name: "发布到目录" }));

    await waitFor(() => expect(actionMocks.createMcpCatalogItem).toHaveBeenCalledTimes(1));
    expect(actionMocks.createMcpCatalogItem).toHaveBeenCalledWith(expect.objectContaining({
      slug: "internal-search",
      displayName: "Internal Search",
      transport: "streamable_http",
      allowedHosts: ["mcp.internal.example"],
      risk: "high",
      declaredTools: [{ name: "search_records", description: "Search internal records", risk: "medium" }],
    }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("publishes a managed stdio release that targets an installed Runtime entrypoint", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={data} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "MCP 市场" }));
    await user.click(screen.getByRole("button", { name: "添加 MCP 服务" }));
    const catalogForm = within(screen.getByRole("dialog", { name: "添加 MCP 服务" }));
    await user.type(catalogForm.getByLabelText("服务名称", { selector: "input" }), "Local MCP");
    await user.selectOptions(catalogForm.getByLabelText("传输"), "managed_stdio");
    await user.type(catalogForm.getByLabelText("已安装入口命令"), "local-mcp");
    await user.type(catalogForm.getByLabelText("工具 1"), "lookup_record");
    await user.type(catalogForm.getByLabelText("说明", { selector: "input" }), "Look up a local record");
    await user.click(catalogForm.getByRole("button", { name: "发布到目录" }));

    await waitFor(() => expect(actionMocks.createMcpCatalogItem).toHaveBeenCalledTimes(1));
    expect(actionMocks.createMcpCatalogItem).toHaveBeenCalledWith(expect.objectContaining({
      transport: "managed_stdio",
      endpointTemplate: "stdio://local-mcp",
      allowedHosts: [],
    }));
  });

  it("switches MCP details when another catalog service is selected", async () => {
    const user = userEvent.setup();
    const minimaxCatalog: MarketPageData["mcpCatalog"][number] = {
      ...data.mcpCatalog[0]!,
      id: "mcp-minimax-token-plan",
      source: "official",
      slug: "official-minimax-token-plan",
      displayName: "MiniMax Token Plan MCP",
      description: "One official MiniMax MCP service providing two tools.",
      version: "0.0.4",
      category: "productivity",
      transport: "managed_stdio",
      endpointTemplate: "stdio://minimax-coding-plan-mcp",
      allowedHosts: ["api.minimaxi.com"],
      secretFields: ["MINIMAX_API_KEY"],
      declaredTools: [
        { name: "web_search", description: "Search the web", risk: "medium" },
        { name: "understand_image", description: "Understand an image", risk: "high" },
      ],
    };
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={{ ...data, mcpCatalog: [...data.mcpCatalog, minimaxCatalog] }} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "MCP 市场" }));
    await user.click(screen.getByRole("button", { name: /^MiniMax Token Plan MCP/ }));

    expect(screen.getByRole("heading", { name: "MiniMax Token Plan MCP" })).toBeInTheDocument();
    expect(screen.getByText("api.minimaxi.com")).toBeInTheDocument();
    expect(screen.getByLabelText("MINIMAX_API_KEY")).toHaveAttribute("type", "password");
  });

  it("installs the pinned Chrome DevTools runtime component from the MCP page before connecting", async () => {
    const user = userEvent.setup();
    const chromeCatalog: MarketPageData["mcpCatalog"][number] = {
      ...data.mcpCatalog[0]!,
      id: "mcp-chrome-devtools",
      source: "official",
      slug: "official-chrome-devtools",
      displayName: "Chrome DevTools MCP",
      version: "1.6.0",
      category: "developer_tools",
      transport: "managed_stdio",
      risk: "high",
      endpointTemplate: "stdio://chrome-devtools-mcp",
      allowedHosts: [],
      secretFields: [],
      configurationFields: [],
      requiredRuntimeApp: { source: "clihub_public", name: "chrome-devtools-mcp", version: "1.6.0" },
    };
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={{
            ...data,
            catalog: [...data.catalog, {
              source: "clihub_public",
              productSource: "official",
              name: "chrome-devtools-mcp",
              displayName: "Chrome DevTools MCP",
              description: "Managed Chrome DevTools server",
              version: "1.6.0",
              category: "developer_tools",
              entryPoint: "chrome-devtools-mcp",
              installStrategy: "npm",
              risk: "low",
              installability: { status: "installable", requiredTools: ["npm"] },
            }],
            mcpCatalog: [chromeCatalog],
          }} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "MCP 市场" }));
    expect(within(screen.getByRole("combobox", { name: "传输" })).getByRole("option", { name: "managed_stdio" })).toBeInTheDocument();
    expect(screen.getByText("chrome-devtools-mcp@1.6.0")).toBeInTheDocument();
    const progress = screen.getByRole("list", { name: "MCP 连接进度" });
    expect(progress).toBeInTheDocument();
    expect(within(progress).getByText("安装依赖 CLI").closest("li")).toHaveAttribute("aria-current", "step");
    expect(within(progress).getByText("配置参数").closest("li")).toHaveClass("mcp-setup-progress__step--pending");
    expect(screen.queryByRole("button", { name: "配置并连接" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /继续：/ })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "继续：安装依赖 CLI" }));

    await waitFor(() => expect(actionMocks.requestOperation).toHaveBeenCalledWith({
      runtimeId: "runtime-online",
      source: "clihub_public",
      name: "chrome-devtools-mcp",
      operation: "install",
    }));
  });

  it("advances the same managed stdio action to verification when its dependency is ready", async () => {
    const user = userEvent.setup();
    const managedCatalog: MarketPageData["mcpCatalog"][number] = {
      ...data.mcpCatalog[0]!,
      id: "mcp-managed-ready",
      source: "official",
      slug: "managed-ready",
      displayName: "Managed Ready MCP",
      transport: "managed_stdio",
      endpointTemplate: "stdio://managed-ready",
      secretFields: [],
      configurationFields: [],
      requiredRuntimeApp: { source: "clihub_public", name: "managed-ready", version: "2.0.0" },
    };
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={{
            ...data,
            mcpCatalog: [managedCatalog],
            installedApps: [{
              runtimeId: "runtime-online",
              source: "clihub_public",
              name: "managed-ready",
              displayName: "Managed Ready",
              version: "2.0.0",
              entryPoint: "managed-ready",
              installStrategy: "npm",
              status: "installed",
              enabled: true,
            }],
          }} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "MCP 市场" }));

    expect(screen.queryByRole("button", { name: "继续：安装依赖 CLI" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续：验证并连接" })).toBeEnabled();
  });

  it("groups one MCP service connected to multiple runtimes without presenting duplicate services", async () => {
    const user = userEvent.setup();
    const chromeCatalog: MarketPageData["mcpCatalog"][number] = {
      ...data.mcpCatalog[0]!,
      id: "mcp-chrome-devtools",
      slug: "official-chrome-devtools",
      displayName: "Chrome DevTools MCP",
      transport: "managed_stdio",
      endpointTemplate: "stdio://chrome-devtools-mcp",
    };
    const runtimes: MarketPageData["runtimes"] = [
      { ...data.runtimes[0]!, id: "runtime-codex", label: "Managed codex", provider: "codex" },
      { ...data.runtimes[0]!, id: "runtime-claude", label: "Managed claude", provider: "claude" },
    ];
    const connectionBase = {
      catalogItemId: chromeCatalog.id,
      catalogSlug: chromeCatalog.slug,
      catalogDisplayName: chromeCatalog.displayName,
      status: "ready",
      transport: "managed_stdio" as const,
      approvedTools: ["list_pages"],
      declaredToolCount: 10,
      lastVerifiedAt: "2026-08-04T03:49:00.000Z",
    };

    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={{
            ...data,
            runtimes,
            mcpCatalog: [chromeCatalog],
            mcpConnections: [
              { ...connectionBase, id: "connection-codex", runtimeId: "runtime-codex" },
              { ...connectionBase, id: "connection-claude", runtimeId: "runtime-claude" },
            ],
          }} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "MCP 市场" }));

    const serviceGroup = screen.getByRole("listitem", { name: "Chrome DevTools MCP，2 个 Runtime 连接" });
    expect(within(serviceGroup).getByText("Chrome DevTools MCP")).toBeInTheDocument();
    expect(within(serviceGroup).getByRole("listitem", { name: "Chrome DevTools MCP · Managed codex" })).toBeInTheDocument();
    expect(within(serviceGroup).getByRole("listitem", { name: "Chrome DevTools MCP · Managed claude" })).toBeInTheDocument();
    expect(screen.getByLabelText("1 个服务，2 个 Runtime 连接")).toBeInTheDocument();
  });

  it("only shows online runtimes in the target runtime selector", () => {
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={data} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByRole("textbox", { name: "搜索应用" })).toBeInTheDocument();
    const runtimeSelect = screen.getByRole("combobox", { name: "目标 runtime" });
    expect(runtimeSelect).toHaveValue("runtime-online");
    expect(screen.getByRole("option", { name: "Online Runtime · online · 可安装" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Offline Runtime/ })).not.toBeInTheDocument();
  });

  it("shows catalog health and uses product source labels instead of storage keys", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={{
            ...data,
            catalog: [
              data.catalog[0]!,
              { ...data.catalog[0]!, name: "official-cli", displayName: "Official CLI", productSource: "official", source: "clihub_public" },
              { ...data.catalog[0]!, name: "skill-cli", displayName: "Skill CLI", productSource: "skill_dependency", source: "skill_dependency" },
            ],
          }} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByLabelText("CLI 目录健康")).toHaveTextContent("目录正常");
    expect(screen.getByLabelText("CLI 目录健康")).toHaveTextContent("1 个条目");
    expect(screen.getByRole("option", { name: "平台官方" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Skill 依赖" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "skill_dependency" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Skill CLI/ }));
    expect(screen.getByText("Skill 依赖", { selector: ".market-fact strong" })).toBeInTheDocument();
  });

  it("localizes CLI facts, source labels, risk, and timestamps in English", () => {
    window.localStorage.setItem("dofe-agent-language", "en");
    render(
      <LanguageProvider initialLanguage="en">
        <FeedbackToastProvider>
          <MarketPageClient data={data} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByLabelText("CLI catalog health")).toHaveTextContent("Catalog current");
    expect(screen.getByText("CLI-Anything harness", { selector: ".market-fact strong" })).toBeInTheDocument();
    expect(screen.getByText("Low risk", { selector: ".status-chip" })).toBeInTheDocument();
    expect(screen.getByText("Source", { selector: ".market-fact span" })).toBeInTheDocument();
  });

  it("blocks mutable releases before an install operation can be requested", () => {
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={{
            ...data,
            catalog: [{
              ...data.catalog[0]!,
              version: "latest",
              installability: { status: "unsupported", code: "runtime_app.release_unpinned", requiredTools: [] },
            }],
          }} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByText("不可安装", { selector: ".market-installability .status-chip" })).toBeInTheDocument();
    expect(screen.getByText(/目录没有提供固定版本/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "安装" })).toBeDisabled();
  });

  it("keeps uninstall available when a catalog release no longer passes install preflight", () => {
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={{
            ...data,
            catalog: [{
              ...data.catalog[0]!,
              installability: { status: "unsupported", code: "runtime_app.install_artifact_unpinned", requiredTools: [] },
            }],
            installedApps: [{
              runtimeId: "runtime-online",
              source: "clihub_harness",
              name: "mermaid",
              status: "installed",
              enabled: true,
              version: "1.0.0",
              entryPoint: "mmdc",
            }],
          }} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByRole("button", { name: "更新" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "卸载" })).toBeEnabled();
  });

  it("renders the CLI catalog in bounded batches", async () => {
    const user = userEvent.setup();
    const catalog = Array.from({ length: 30 }, (_, index) => ({
      ...data.catalog[0]!,
      name: `app-${index + 1}`,
      displayName: `App ${index + 1}`,
      entryPoint: `app-${index + 1}`,
    }));

    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={{ ...data, catalog }} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    const catalogRegion = screen.getByRole("region", { name: "CLI-Hub 应用目录" });
    expect(catalogRegion.querySelectorAll(".market-app-row")).toHaveLength(24);
    expect(screen.getByText("已显示 24/30")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "加载更多应用" }));
    expect(catalogRegion.querySelectorAll(".market-app-row")).toHaveLength(30);
  });

  it("shows the first matching app details when the current selection is filtered out", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={{
            ...data,
            catalog: [
              data.catalog[0]!,
              { ...data.catalog[0]!, name: "second-app", displayName: "Second App", entryPoint: "second-app" },
            ],
          }} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.type(screen.getByRole("textbox", { name: "搜索应用" }), "Second App");
    expect(screen.getByRole("heading", { name: "Second App" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Mermaid" })).not.toBeInTheDocument();
  });

  it("uses URL history for market tabs and follows browser navigation", async () => {
    const user = userEvent.setup();
    const rendered = render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={data} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("tab", { name: /MCP/ }));
    expect(screen.getByRole("textbox", { name: "搜索 MCP 服务" })).toBeInTheDocument();
    expect(navigationMocks.push).toHaveBeenCalledWith("?tab=mcp", { scroll: false });
    expect(screen.getByRole("tab", { name: /MCP/ })).toHaveAttribute("aria-current", "page");

    navigationMocks.searchParams = new URLSearchParams("tab=mcp");
    rendered.rerender(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={data} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    navigationMocks.searchParams = new URLSearchParams();
    rendered.rerender(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={data} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await waitFor(() => expect(screen.getByRole("tab", { name: "CLI 市场" })).toHaveAttribute("aria-current", "page"));
  });

  it("shows the real failed operation error for the selected runtime app", () => {
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient
            data={{
              ...data,
              installedApps: [
                {
                  runtimeId: "runtime-online",
                  source: "clihub_harness",
                  name: "mermaid",
                  status: "failed",
                  enabled: true,
                  version: "1.0.0",
                  entryPoint: "mmdc",
                  lastError: "Older installed app error",
                },
              ],
              operations: [
                {
                  id: "runtime-app-op-1",
                  runtimeId: "runtime-online",
                  appSource: "clihub_harness",
                  appName: "mermaid",
                  operation: "install",
                  status: "failed",
                  createdAt: "2026-05-08T12:51:08.058Z",
                  errorMessage: "python -m pip install --user cli-anything-hub exited with code 1. No matching distribution found for cli-anything-hub",
                },
              ],
            }}
          />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getAllByText("failed").length).toBeGreaterThan(0);
    expect(screen.getByRole("alert")).toHaveTextContent("No matching distribution found for cli-anything-hub");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Older installed app error");
  });

  it("separates failed attempts from installed apps and retries an online Runtime", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient
            data={{
              ...data,
              installedApps: [
                {
                  runtimeId: "runtime-offline",
                  source: "clihub_harness",
                  name: "mermaid",
                  status: "installed",
                  enabled: true,
                  version: "1.0.0",
                  entryPoint: "mmdc",
                },
                {
                  runtimeId: "runtime-online",
                  source: "clihub_harness",
                  name: "mermaid",
                  status: "failed",
                  enabled: true,
                  version: "1.0.0",
                  entryPoint: "mmdc",
                  lastError: "request to https://hkuds.github.io/CLI-Anything/registry.json failed with SSL error",
                },
              ],
            }}
          />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    const installedSection = screen.getByRole("region", { name: "已安装应用" });
    const attentionSection = screen.getByRole("region", { name: "需要处理" });
    expect(within(installedSection).getByText("Offline Runtime")).toBeInTheDocument();
    expect(within(installedSection).queryByText("失败")).not.toBeInTheDocument();
    expect(within(attentionSection).getByText("Online Runtime")).toBeInTheDocument();
    expect(within(attentionSection).getByText(/系统已改用工作区同步的本地目录/)).toBeInTheDocument();

    await user.click(within(attentionSection).getByRole("button", { name: "重试安装" }));

    await waitFor(() => expect(actionMocks.requestOperation).toHaveBeenCalledWith({
      runtimeId: "runtime-online",
      source: "clihub_harness",
      name: "mermaid",
      operation: "install",
      confirmHighRisk: false,
    }));
  });

  it("turns managed runtime network failures into an actionable operator message", () => {
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient
            data={{
              ...data,
              operations: [{
                id: "runtime-app-op-network",
                runtimeId: "runtime-online",
                appSource: "clihub_harness",
                appName: "mermaid",
                operation: "install",
                status: "failed",
                createdAt: "2026-08-03T14:44:35.301Z",
                errorMessage: "managed_runtime.docker_network_required",
              }],
            }}
          />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("目标 Runtime 缺少隔离安装网络");
    expect(screen.getByRole("alert")).not.toHaveTextContent("managed_runtime.docker_network_required");
  });

  it("explains unstable GitHub source connections without exposing raw command output", () => {
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient
            data={{
              ...data,
              operations: [{
                id: "runtime-app-op-github-tls",
                runtimeId: "runtime-online",
                appSource: "clihub_harness",
                appName: "mermaid",
                operation: "install",
                status: "failed",
                createdAt: "2026-08-03T14:44:35.301Z",
                errorMessage: "Runtime application command failed (docker, exit code 1). fatal: unable to access https://github.com/example/tool.git: GnuTLS recv error (-110)",
              }],
            }}
          />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Runtime 访问 GitHub 源码不稳定");
    expect(screen.getByRole("alert")).not.toHaveTextContent("GnuTLS recv error");
  });

  it("does not expose Docker commands or stack traces in the market detail", () => {
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient
            data={{
              ...data,
              operations: [{
                id: "runtime-app-op-internal-error",
                runtimeId: "runtime-online",
                appSource: "clihub_harness",
                appName: "mermaid",
                operation: "install",
                status: "failed",
                createdAt: "2026-08-03T14:44:35.301Z",
                errorMessage: "docker run --rm secret-image failed\nTraceback: internal details",
              }],
            }}
          />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("完整诊断已保留在执行记录中");
    expect(screen.getByRole("alert")).not.toHaveTextContent("secret-image");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Traceback");
  });

  it("refreshes while runtime app operations are still active", () => {
    vi.useFakeTimers();

    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient
            data={{
              ...data,
              operations: [
                {
                  id: "runtime-app-op-2",
                  runtimeId: "runtime-online",
                  appSource: "clihub_harness",
                  appName: "mermaid",
                  operation: "install",
                  status: "running",
                  createdAt: "2026-05-08T12:51:08.058Z",
                },
              ],
            }}
          />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    expect(screen.getByText("running")).toBeInTheDocument();
    vi.advanceTimersByTime(2_500);

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("uses module refresh callback for polling inside the workbench", () => {
    vi.useFakeTimers();
    const onDataChanged = vi.fn();

    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient
            data={{
              ...data,
              operations: [
                {
                  id: "runtime-app-op-2",
                  runtimeId: "runtime-online",
                  appSource: "clihub_harness",
                  appName: "mermaid",
                  operation: "install",
                  status: "running",
                  createdAt: "2026-05-08T12:51:08.058Z",
                },
              ],
            }}
            onDataChanged={onDataChanged}
          />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    vi.advanceTimersByTime(2_500);
    expect(onDataChanged).toHaveBeenCalledTimes(1);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("uses module refresh callback for actions inside the workbench", async () => {
    const user = userEvent.setup();
    const onDataChanged = vi.fn();

    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={data} onDataChanged={onDataChanged} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: /刷新目录/ }));

    expect(actionMocks.refreshCatalog).toHaveBeenCalledTimes(1);
    expect(onDataChanged).toHaveBeenCalledTimes(1);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("submits only schema-declared non-secret MCP configuration", async () => {
    const user = userEvent.setup();

    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={data} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("tab", { name: /MCP/ }));
    await user.type(screen.getByLabelText("X-Workspace *"), "workspace-42");
    await user.type(screen.getByLabelText("Authorization"), "secret-token");
    await user.click(screen.getByRole("button", { name: /配置并连接/ }));

    await waitFor(() => {
      expect(actionMocks.requestMcpConnection).toHaveBeenCalledWith(expect.objectContaining({
        catalogItemId: "mcp-catalog-1",
        nonSecretParams: { "X-Workspace": "workspace-42" },
        secrets: { Authorization: "secret-token" },
      }));
    });
  });

  it("filters MCP catalog entries by category, reviewed source, risk, and connection health", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={{
            ...data,
            mcpCatalog: [
              data.mcpCatalog[0]!,
              {
                ...data.mcpCatalog[0]!,
                id: "mcp-catalog-2",
                source: "official",
                slug: "official-search",
                displayName: "Official Search",
                category: "developer_tools",
                transport: "streamable_http",
                risk: "high",
              },
            ],
            mcpConnections: [{
              id: "connection-1",
              runtimeId: "runtime-online",
              catalogItemId: "mcp-catalog-2",
              catalogSlug: "official-search",
              catalogDisplayName: "Official Search",
              status: "degraded",
              transport: "streamable_http",
              approvedTools: ["search"],
              declaredToolCount: 1,
            }],
          }} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("tab", { name: /MCP/ }));
    await user.selectOptions(screen.getByRole("combobox", { name: "类别" }), "developer_tools");
    await user.selectOptions(screen.getByRole("combobox", { name: "来源" }), "official");
    await user.selectOptions(screen.getByRole("combobox", { name: "风险" }), "high");
    await user.selectOptions(screen.getByRole("combobox", { name: "连接状态" }), "needs_attention");

    const catalogRegion = screen.getByRole("region", { name: "MCP 服务目录" });
    expect(within(catalogRegion).getByRole("button", { name: /Official Search/ })).toBeInTheDocument();
    expect(within(catalogRegion).queryByRole("button", { name: /Workspace Search/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Official Search" })).toBeInTheDocument();
  });

  it("shows connection verification diagnostics and safely enters configuration replacement mode", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={{
            ...data,
            mcpConnections: [{
              id: "connection-1",
              runtimeId: "runtime-online",
              catalogItemId: "mcp-catalog-1",
              catalogSlug: "workspace-search",
              catalogDisplayName: "Workspace Search",
              status: "ready",
              transport: "streamable_http",
              approvedTools: ["search"],
              declaredToolCount: 1,
              lastVerifiedAt: "2026-08-02T08:30:00.000Z",
            }],
          }} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("tab", { name: /MCP/ }));
    expect(screen.getByText(/上次验证/)).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "Workspace Search · Online Runtime" })).toBeInTheDocument();
    const toolSummary = screen.getByText("查看工具 (1)");
    await user.click(toolSummary);
    expect(toolSummary.closest("details")).toHaveAttribute("open");
    await user.click(screen.getByRole("button", { name: "管理 Online Runtime 的 Workspace Search 配置" }));
    expect(screen.getByText(/不会回显/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("X-Workspace *"), "workspace-42");
    await user.click(screen.getByRole("button", { name: "更新并重新验证" }));

    await waitFor(() => expect(actionMocks.replaceMcpConnectionConfig).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "connection-1",
      endpoint: undefined,
      nonSecretParams: { "X-Workspace": "workspace-42" },
      approvedTools: ["search"],
      secrets: undefined,
    })));
    expect(actionMocks.rotateMcpSecret).not.toHaveBeenCalled();
  });

  it("submits an edit without re-entering untouched required config", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={{
            ...data,
            mcpConnections: [{
              id: "connection-1",
              runtimeId: "runtime-online",
              catalogItemId: "mcp-catalog-1",
              catalogSlug: "workspace-search",
              catalogDisplayName: "Workspace Search",
              status: "ready",
              transport: "streamable_http",
              approvedTools: ["search"],
              declaredToolCount: 1,
              lastVerifiedAt: "2026-08-02T08:30:00.000Z",
            }],
          }} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("tab", { name: /MCP/ }));
    await user.click(screen.getByRole("button", { name: "管理 Online Runtime 的 Workspace Search 配置" }));
    // Do not re-type the required X-Workspace field.
    await user.click(screen.getByRole("button", { name: "更新并重新验证" }));

    await waitFor(() => expect(actionMocks.replaceMcpConnectionConfig).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "connection-1",
      endpoint: undefined,
      nonSecretParams: undefined,
      approvedTools: ["search"],
      secrets: undefined,
    })));
  });

  it("preserves dirty-state protection when entering edit from a different catalog", async () => {
    const user = userEvent.setup();
    render(
      <LanguageProvider>
        <FeedbackToastProvider>
          <MarketPageClient data={{
            ...data,
            mcpCatalog: [
              data.mcpCatalog[0]!,
              {
                ...data.mcpCatalog[0]!,
                id: "mcp-catalog-2",
                slug: "other-search",
                displayName: "Other Search",
                endpointTemplate: "https://other.example.com/mcp",
              },
            ],
            mcpConnections: [{
              id: "connection-1",
              runtimeId: "runtime-online",
              catalogItemId: "mcp-catalog-1",
              catalogSlug: "workspace-search",
              catalogDisplayName: "Workspace Search",
              status: "ready",
              transport: "streamable_http",
              approvedTools: ["search"],
              declaredToolCount: 1,
              lastVerifiedAt: "2026-08-02T08:30:00.000Z",
            }],
          }} />
        </FeedbackToastProvider>
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("tab", { name: /MCP/ }));
    // First select the other catalog so the per-selection effect runs once.
    await user.click(screen.getByRole("button", { name: /Other Search/ }));
    // Then enter edit mode for a connection of the first catalog.
    await user.click(screen.getByRole("button", { name: "管理 Online Runtime 的 Workspace Search 配置" }));
    await user.click(screen.getByRole("button", { name: "更新并重新验证" }));

    await waitFor(() => expect(actionMocks.replaceMcpConnectionConfig).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "connection-1",
      endpoint: undefined,
      nonSecretParams: undefined,
      approvedTools: ["search"],
      secrets: undefined,
    })));
  });
});
