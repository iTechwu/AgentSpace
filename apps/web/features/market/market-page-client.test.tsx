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
      name: "mermaid",
      displayName: "Mermaid",
      description: "Render diagrams",
      version: "1.0.0",
      category: "diagram",
      entryPoint: "mmdc",
      installStrategy: "cli_hub",
      risk: "low",
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
      mcpEligible: true,
    },
    {
      id: "runtime-offline",
      label: "Offline Runtime",
      provider: "codex",
      status: "offline",
      daemonKey: "daemon-offline",
      cliHubReady: false,
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
    expect(screen.getByRole("option", { name: /Online Runtime/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Offline Runtime/ })).not.toBeInTheDocument();
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

    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("No matching distribution found for cli-anything-hub");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Older installed app error");
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

    expect(screen.getByRole("button", { name: /Official Search/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Workspace Search/ })).not.toBeInTheDocument();
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
    const toolSummary = screen.getByText("查看工具 (1)");
    await user.click(toolSummary);
    expect(toolSummary.closest("details")).toHaveAttribute("open");
    await user.click(screen.getByRole("button", { name: "管理配置" }));
    expect(screen.getByText(/不会回显/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("X-Workspace *"), "workspace-42");
    await user.click(screen.getByRole("button", { name: "更新配置" }));

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
    await user.click(screen.getByRole("button", { name: "管理配置" }));
    // Do not re-type the required X-Workspace field.
    await user.click(screen.getByRole("button", { name: "更新配置" }));

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
    await user.click(screen.getByRole("button", { name: "管理配置" }));
    await user.click(screen.getByRole("button", { name: "更新配置" }));

    await waitFor(() => expect(actionMocks.replaceMcpConnectionConfig).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: "connection-1",
      endpoint: undefined,
      nonSecretParams: undefined,
      approvedTools: ["search"],
      secrets: undefined,
    })));
  });
});
