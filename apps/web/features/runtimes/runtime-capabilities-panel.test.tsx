import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeCapabilitiesPanel } from "@/features/runtimes/runtime-capabilities-panel";
import type { MarketPageData } from "@/features/market/market-page-client";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { FeedbackToastProvider } from "@/shared/ui/feedback-toast-provider";

const actionMocks = vi.hoisted(() => ({
  requestCli: vi.fn(async () => ({ data: undefined })),
  requestMcp: vi.fn(async () => ({ data: undefined })),
  removeMcp: vi.fn(async () => ({ data: undefined })),
  reverifyMcp: vi.fn(async () => ({ data: undefined })),
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: actionMocks.refresh }) }));
vi.mock("@/features/market/actions", () => ({ requestRuntimeAppOperationAction: actionMocks.requestCli }));
vi.mock("@/features/market/mcp-actions", () => ({
  requestMcpConnectionAction: actionMocks.requestMcp,
  removeMcpConnectionAction: actionMocks.removeMcp,
  reverifyMcpConnectionAction: actionMocks.reverifyMcp,
}));

const data: MarketPageData = {
  catalog: [{
    source: "clihub_public",
    productSource: "clihub_public",
    name: "mermaid",
    displayName: "Mermaid CLI",
    description: "Render diagrams",
    version: "1.0.0",
    category: "diagram",
    entryPoint: "mmdc",
    installStrategy: "cli_hub",
    risk: "low",
    installability: { status: "installable", requiredTools: ["cli_hub"] },
  }],
  catalogHealth: { itemCount: 1, stale: false },
  runtimes: [{ id: "runtime-1", label: "Managed codex", provider: "codex", status: "online", daemonKey: "daemon-1", cliHubReady: true, cliReadiness: { npm: true, python: true, pip: true, cliHub: true }, mcpEligible: true }],
  installedApps: [],
  operations: [],
  mcpCatalog: [{
    id: "mcp-search",
    source: "official",
    slug: "official-search",
    displayName: "Search MCP",
    description: "Search records",
    version: "1.0.0",
    category: "productivity",
    transport: "streamable_http",
    risk: "low",
    allowedHosts: ["mcp.example.com"],
    dataDomains: ["workspace"],
    declaredTools: [{ name: "search", description: "Search", risk: "low" }],
    defaultApprovedTools: ["search"],
    secretFields: [],
    configurationFields: [],
    endpointTemplate: "https://mcp.example.com/mcp",
  }],
  mcpConnections: [],
  mcpOperations: [],
  canManage: true,
};

function renderPanel(panelData: MarketPageData = data, language: "zh" | "en" = "zh") {
  return render(
    <LanguageProvider initialLanguage={language}>
      <FeedbackToastProvider>
        <RuntimeCapabilitiesPanel data={panelData} runtimeId="runtime-1" runtimeName="Managed codex" runtimeStatus="online" workspaceSlug="k22" />
      </FeedbackToastProvider>
    </LanguageProvider>,
  );
}

describe("RuntimeCapabilitiesPanel", () => {
  beforeEach(() => {
    Object.values(actionMocks).forEach((mock) => mock.mockClear());
    window.localStorage.removeItem("dofe-agent-language");
  });

  it("installs a CLI app directly from runtime details", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "安装 CLI" }));
    await user.click(screen.getByRole("button", { name: "安装" }));

    await waitFor(() => expect(actionMocks.requestCli).toHaveBeenCalledWith({
      runtimeId: "runtime-1",
      source: "clihub_public",
      name: "mermaid",
      operation: "install",
      confirmHighRisk: false,
    }));
  });

  it("configures and connects an MCP service directly from runtime details", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getAllByRole("button", { name: "连接 MCP" }).at(-1)!);
    await user.click(screen.getByRole("button", { name: "配置并连接" }));
    await user.click(screen.getByRole("button", { name: "继续：验证并连接" }));

    await waitFor(() => expect(actionMocks.requestMcp).toHaveBeenCalledWith({
      runtimeId: "runtime-1",
      catalogItemId: "mcp-search",
      endpoint: "https://mcp.example.com/mcp",
      nonSecretParams: {},
      secrets: {},
      approvedTools: ["search"],
      confirmHighRisk: false,
    }));
  });

  it("uses one managed stdio action to install the required CLI from runtime details", async () => {
    const user = userEvent.setup();
    renderPanel({
      ...data,
      catalog: [{
        ...data.catalog[0]!,
        source: "clihub_public",
        productSource: "official",
        name: "managed-search",
        displayName: "Managed Search CLI",
        version: "2.1.0",
        entryPoint: "managed-search",
        installStrategy: "npm",
        installability: { status: "installable", requiredTools: ["npm"] },
      }],
      mcpCatalog: [{
        ...data.mcpCatalog[0]!,
        id: "mcp-managed-search",
        slug: "managed-search",
        displayName: "Managed Search MCP",
        transport: "managed_stdio",
        endpointTemplate: "stdio://managed-search",
        requiredRuntimeApp: { source: "clihub_public", name: "managed-search", version: "2.1.0" },
      }],
    });

    await user.click(screen.getAllByRole("button", { name: "连接 MCP" }).at(-1)!);
    await user.click(screen.getByRole("button", { name: "配置并连接" }));

    expect(screen.getByRole("list", { name: "MCP 连接进度" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /继续：/ })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "继续：安装依赖 CLI" }));

    await waitFor(() => expect(actionMocks.requestCli).toHaveBeenCalledWith({
      runtimeId: "runtime-1",
      source: "clihub_public",
      name: "managed-search",
      operation: "install",
    }));
    expect(actionMocks.requestMcp).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before installing a high-risk CLI", async () => {
    const user = userEvent.setup();
    renderPanel({ ...data, catalog: [{ ...data.catalog[0]!, risk: "high" }] });

    await user.click(screen.getByRole("button", { name: "安装 CLI" }));
    await user.click(screen.getByRole("button", { name: "审核安装" }));

    expect(screen.getByRole("button", { name: "安装" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "确认高风险安装" }));
    await user.click(screen.getByRole("button", { name: "安装" }));

    await waitFor(() => expect(actionMocks.requestCli).toHaveBeenCalledWith(expect.objectContaining({
      name: "mermaid",
      confirmHighRisk: true,
    })));
  });

  it("uses the same installability projection as the market", async () => {
    const user = userEvent.setup();
    renderPanel({
      ...data,
      catalog: [{
        ...data.catalog[0]!,
        version: "latest",
        installability: { status: "unsupported", code: "runtime_app.release_unpinned", requiredTools: [] },
      }],
    });

    await user.click(screen.getByRole("button", { name: "安装 CLI" }));

    expect(screen.getByText("不可安装", { selector: ".runtime-capability-row .status-chip" })).toBeInTheDocument();
    expect(screen.getByText(/目录没有提供固定版本/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "安装" })).toBeDisabled();
  });

  it("keeps current capabilities, catalog, and installation history as explicit views", async () => {
    const user = userEvent.setup();
    renderPanel({
      ...data,
      installedApps: [{
        runtimeId: "runtime-1",
        source: "clihub_public",
        name: "mermaid",
        version: "1.0.0",
        entryPoint: "mmdc",
        status: "installed",
        enabled: true,
        updatedAt: "2026-08-04T08:00:00.000Z",
      }],
      operations: [{
        id: "operation-1",
        runtimeId: "runtime-1",
        appSource: "clihub_public",
        appName: "mermaid",
        operation: "install",
        status: "succeeded",
        createdAt: "2026-08-04T08:00:00.000Z",
      }],
    });

    expect(screen.getByRole("tab", { name: "当前能力" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Mermaid CLI")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /安装记录/ }));

    expect(screen.getByText("CLI 安装记录")).toBeInTheDocument();
    expect(screen.getByText("已成功")).toBeInTheDocument();
    expect(screen.getByText("MCP 操作记录")).toBeInTheDocument();
  });

  it("localizes empty history, operation status, and dates in English", async () => {
    const user = userEvent.setup();
    renderPanel({
      ...data,
      operations: [{
        id: "operation-en",
        runtimeId: "runtime-1",
        appSource: "clihub_public",
        appName: "mermaid",
        operation: "install",
        status: "succeeded",
        createdAt: "2026-08-04T08:00:00.000Z",
      }],
    }, "en");

    await user.click(screen.getByRole("tab", { name: /Installation history/ }));

    expect(screen.getByText((_, element) => element?.tagName === "SMALL" && element.textContent?.startsWith("Install ·") === true)).toBeInTheDocument();
    expect(screen.getByText(/Aug 4, 2026/, { selector: "time" })).toBeInTheDocument();
    expect(screen.getByText("Succeeded")).toBeInTheDocument();
    expect(screen.getByText("No records")).toBeInTheDocument();
    expect(screen.queryByText("暂无记录")).not.toBeInTheDocument();
  });
});
