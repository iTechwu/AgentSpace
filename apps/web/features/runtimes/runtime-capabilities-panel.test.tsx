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
    name: "mermaid",
    displayName: "Mermaid CLI",
    description: "Render diagrams",
    version: "1.0.0",
    category: "diagram",
    entryPoint: "mmdc",
    installStrategy: "cli_hub",
    risk: "low",
  }],
  catalogHealth: { itemCount: 1, stale: false },
  runtimes: [{ id: "runtime-1", label: "Managed codex", provider: "codex", status: "online", daemonKey: "daemon-1", cliHubReady: true, mcpEligible: true }],
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

function renderPanel(panelData: MarketPageData = data) {
  return render(
    <LanguageProvider>
      <FeedbackToastProvider>
        <RuntimeCapabilitiesPanel data={panelData} runtimeId="runtime-1" runtimeName="Managed codex" runtimeStatus="online" workspaceSlug="k22" />
      </FeedbackToastProvider>
    </LanguageProvider>,
  );
}

describe("RuntimeCapabilitiesPanel", () => {
  beforeEach(() => {
    Object.values(actionMocks).forEach((mock) => mock.mockClear());
  });

  it("installs a CLI app directly from runtime details", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "全部目录" }));
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

    await user.click(screen.getByRole("tab", { name: /MCP/ }));
    await user.click(screen.getByRole("button", { name: "全部目录" }));
    await user.click(screen.getByRole("button", { name: "配置并连接" }));
    await user.click(screen.getByRole("button", { name: "连接 MCP" }));

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

  it("requires explicit confirmation before installing a high-risk CLI", async () => {
    const user = userEvent.setup();
    renderPanel({ ...data, catalog: [{ ...data.catalog[0]!, risk: "high" }] });

    await user.click(screen.getByRole("button", { name: "全部目录" }));
    await user.click(screen.getByRole("button", { name: "审核安装" }));

    expect(screen.getByRole("button", { name: "安装" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: "确认高风险安装" }));
    await user.click(screen.getByRole("button", { name: "安装" }));

    await waitFor(() => expect(actionMocks.requestCli).toHaveBeenCalledWith(expect.objectContaining({
      name: "mermaid",
      confirmHighRisk: true,
    })));
  });
});
