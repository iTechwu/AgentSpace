import {
  readMcpCatalogItemReleaseSync,
  upsertMcpCatalogItemSync,
  upsertRuntimeAppCatalogItemsSync,
  type McpCatalogItemRecord,
} from "@dofe-agent/db";
import type { McpManagedStdioProfile } from "@dofe-agent/domain";

export const CHROME_DEVTOOLS_MCP_SLUG = "official-chrome-devtools";
export const CHROME_DEVTOOLS_MCP_VERSION = "1.6.0";
export const CHROME_DEVTOOLS_MCP_PACKAGE_SPEC = `chrome-devtools-mcp@${CHROME_DEVTOOLS_MCP_VERSION}`;
export const MINIMAX_TOKEN_PLAN_MCP_SLUG = "official-minimax-token-plan";
export const MINIMAX_TOKEN_PLAN_MCP_VERSION = "0.0.4";
export const MINIMAX_TOKEN_PLAN_MCP_PACKAGE = "minimax-coding-plan-mcp";
export const MINIMAX_TOKEN_PLAN_MCP_PACKAGE_SPEC = `${MINIMAX_TOKEN_PLAN_MCP_PACKAGE}==${MINIMAX_TOKEN_PLAN_MCP_VERSION}`;

export interface OfficialMcpRuntimeAppRequirement {
  source: "clihub_public";
  name: string;
  version: string;
}

const CHROME_DEVTOOLS_TOOLS = [
  { name: "click", description: "Click an element on the selected page.", risk: "high" as const },
  { name: "close_page", description: "Close a browser page.", risk: "medium" as const },
  { name: "drag", description: "Drag one page element onto another.", risk: "high" as const },
  { name: "emulate", description: "Emulate browser, device, network, geolocation, or media features.", risk: "medium" as const },
  { name: "evaluate_script", description: "Evaluate JavaScript in the selected page.", risk: "high" as const },
  { name: "fill", description: "Fill a page input, textarea, or select element.", risk: "high" as const },
  { name: "fill_form", description: "Fill multiple form elements in one operation.", risk: "high" as const },
  { name: "get_console_message", description: "Read one console message by identifier.", risk: "low" as const },
  { name: "get_network_request", description: "Read details for one network request.", risk: "low" as const },
  { name: "handle_dialog", description: "Accept or dismiss a browser dialog.", risk: "high" as const },
  { name: "hover", description: "Hover over a page element.", risk: "medium" as const },
  { name: "lighthouse_audit", description: "Run accessibility, SEO, best-practice, and agentic browsing audits.", risk: "medium" as const },
  { name: "list_console_messages", description: "List console messages from the selected page.", risk: "low" as const },
  { name: "list_network_requests", description: "List network requests from the selected page.", risk: "low" as const },
  { name: "list_pages", description: "List browser pages available to Chrome DevTools.", risk: "low" as const },
  { name: "navigate_page", description: "Navigate, reload, or move through the selected page history.", risk: "high" as const },
  { name: "new_page", description: "Open a new browser page and navigate it to a URL.", risk: "high" as const },
  { name: "performance_analyze_insight", description: "Analyze an insight from the active performance trace.", risk: "low" as const },
  { name: "performance_start_trace", description: "Start a Chrome performance trace.", risk: "medium" as const },
  { name: "performance_stop_trace", description: "Stop the active Chrome performance trace.", risk: "medium" as const },
  { name: "press_key", description: "Send a keyboard command to the selected page.", risk: "high" as const },
  { name: "resize_page", description: "Resize the selected browser page.", risk: "medium" as const },
  { name: "select_page", description: "Select the browser page used by later DevTools calls.", risk: "low" as const },
  { name: "take_heapsnapshot", description: "Capture a JavaScript heap snapshot for memory analysis.", risk: "medium" as const },
  { name: "take_screenshot", description: "Capture a screenshot of the selected page or element.", risk: "low" as const },
  { name: "take_snapshot", description: "Read an accessibility snapshot of the selected page.", risk: "low" as const },
  { name: "type_text", description: "Type text into the currently focused page element.", risk: "high" as const },
  { name: "upload_file", description: "Upload a local file through a page element.", risk: "high" as const },
  { name: "wait_for", description: "Wait for text to appear on the selected page.", risk: "low" as const },
] as const;

const DEFAULT_APPROVED_TOOLS = CHROME_DEVTOOLS_TOOLS
  .filter((tool) => tool.risk === "low")
  .map((tool) => tool.name);

const MINIMAX_TOKEN_PLAN_TOOLS = [
  { name: "web_search", description: "Search the public web through the MiniMax Token Plan API.", risk: "medium" as const },
  { name: "understand_image", description: "Analyze an image through the MiniMax Token Plan API.", risk: "high" as const },
] as const;

const CHROME_DEVTOOLS_STDIO_PROFILE: McpManagedStdioProfile = {
  args: [
    "--headless",
    "--isolated",
    "--no-usage-statistics",
    "--no-performance-crux",
  ],
  managedArgs: [
    "--executable-path=/usr/bin/chromium",
    "--chrome-arg=--no-sandbox",
  ],
  env: {
    CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
    CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
    CI: "1",
  },
};

const MINIMAX_TOKEN_PLAN_STDIO_PROFILE: McpManagedStdioProfile = {
  args: [],
  env: {
    MINIMAX_API_HOST: "https://api.minimaxi.com",
  },
};

export function syncOfficialMcpCatalogForWorkspaceSync(workspaceId: string): McpCatalogItemRecord {
  const syncedAt = new Date().toISOString();
  upsertRuntimeAppCatalogItemsSync([
    {
      source: "clihub_public",
      name: "chrome-devtools-mcp",
      displayName: "Chrome DevTools MCP",
      description: "Inspect, automate, debug, and profile an isolated Chrome browser.",
      version: CHROME_DEVTOOLS_MCP_VERSION,
      category: "developer_tools",
      entryPoint: "chrome-devtools-mcp",
      installStrategy: "npm",
      installCmd: `npm install --global ${CHROME_DEVTOOLS_MCP_PACKAGE_SPEC}`,
      requiresText: "Node.js 20.19+ and Chrome available in the target Runtime image.",
      homepage: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
      registryJson: JSON.stringify({
        npm_package: "chrome-devtools-mcp",
        npm_package_spec: CHROME_DEVTOOLS_MCP_PACKAGE_SPEC,
        npm_integrity: "sha512-VZX6f/OjQSYhy2BGGRs+y3LsrsAQAz/HwZCWKBLVyST/4r/3zjVEjjVW7gMCVbRDuspnVdcp5hQDPrQ5UFrdZw==",
        repository: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
      }),
      syncedAt,
    },
    {
      source: "clihub_public",
      name: MINIMAX_TOKEN_PLAN_MCP_PACKAGE,
      displayName: "MiniMax Token Plan MCP",
      description: "Official MiniMax Token Plan MCP server with web search and image understanding tools.",
      version: MINIMAX_TOKEN_PLAN_MCP_VERSION,
      category: "search",
      entryPoint: MINIMAX_TOKEN_PLAN_MCP_PACKAGE,
      installStrategy: "pip",
      installCmd: `python3 -m pip install --user ${MINIMAX_TOKEN_PLAN_MCP_PACKAGE_SPEC}`,
      requiresText: "Python 3.10+, a MiniMax Token Plan API key, and approved access to api.minimaxi.com.",
      homepage: "https://platform.minimaxi.com/docs/guides/token-plan-mcp-guide",
      registryJson: JSON.stringify({
        pypi_package: MINIMAX_TOKEN_PLAN_MCP_PACKAGE,
        pypi_package_spec: MINIMAX_TOKEN_PLAN_MCP_PACKAGE_SPEC,
        pypi_sha256: "ef20ded2c716dfb33a446f8608b58d5fc3a8f76db744f1805d1b412906622572",
      }),
      syncedAt,
    },
  ]);

  const chrome = readOfficialReleaseOrCreate(workspaceId, CHROME_DEVTOOLS_MCP_SLUG, CHROME_DEVTOOLS_MCP_VERSION, {
    workspaceId,
    source: "official",
    slug: CHROME_DEVTOOLS_MCP_SLUG,
    version: CHROME_DEVTOOLS_MCP_VERSION,
    category: "developer_tools",
    transport: "managed_stdio",
    displayName: "Chrome DevTools MCP",
    description: "Inspect browser pages, console output, network traffic, screenshots, accessibility, and performance traces.",
    allowedHostsJson: "[]",
    configurationSchemaJson: JSON.stringify({ type: "object", properties: {}, required: [], additionalProperties: false }),
    declaredToolsJson: JSON.stringify(CHROME_DEVTOOLS_TOOLS),
    defaultApprovedToolsJson: JSON.stringify(DEFAULT_APPROVED_TOOLS),
    secretFieldsJson: "[]",
    requiredRuntimeCapabilitiesJson: JSON.stringify(["node>=20.19", "chromium", "chrome-devtools-mcp"]),
    dataDomainsJson: JSON.stringify(["browser_pages", "console", "network", "performance"]),
    risk: "high",
    endpointTemplate: "stdio://chrome-devtools-mcp",
    documentationUrl: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
  });

  readOfficialReleaseOrCreate(workspaceId, MINIMAX_TOKEN_PLAN_MCP_SLUG, MINIMAX_TOKEN_PLAN_MCP_VERSION, {
    workspaceId,
    source: "official",
    slug: MINIMAX_TOKEN_PLAN_MCP_SLUG,
    version: MINIMAX_TOKEN_PLAN_MCP_VERSION,
    category: "productivity",
    transport: "managed_stdio",
    displayName: "MiniMax Token Plan MCP",
    description: "One official MiniMax MCP service providing web_search and understand_image.",
    allowedHostsJson: JSON.stringify(["api.minimaxi.com"]),
    configurationSchemaJson: JSON.stringify({ type: "object", properties: {}, required: [], additionalProperties: false }),
    declaredToolsJson: JSON.stringify(MINIMAX_TOKEN_PLAN_TOOLS),
    defaultApprovedToolsJson: "[]",
    secretFieldsJson: JSON.stringify(["MINIMAX_API_KEY"]),
    requiredRuntimeCapabilitiesJson: JSON.stringify(["python>=3.10", MINIMAX_TOKEN_PLAN_MCP_PACKAGE]),
    dataDomainsJson: JSON.stringify(["public_web_queries", "external_images"]),
    risk: "high",
    endpointTemplate: `stdio://${MINIMAX_TOKEN_PLAN_MCP_PACKAGE}`,
    documentationUrl: "https://platform.minimaxi.com/docs/guides/token-plan-mcp-guide",
  });

  return chrome;
}

export function resolveOfficialManagedStdioProfile(
  catalog: Pick<McpCatalogItemRecord, "source" | "slug" | "version" | "transport">,
): McpManagedStdioProfile | undefined {
  if (catalog.source !== "official" || catalog.transport !== "managed_stdio") return undefined;
  if (catalog.slug === CHROME_DEVTOOLS_MCP_SLUG && catalog.version === CHROME_DEVTOOLS_MCP_VERSION) {
    return cloneManagedStdioProfile(CHROME_DEVTOOLS_STDIO_PROFILE);
  }
  if (catalog.slug === MINIMAX_TOKEN_PLAN_MCP_SLUG && catalog.version === MINIMAX_TOKEN_PLAN_MCP_VERSION) {
    return cloneManagedStdioProfile(MINIMAX_TOKEN_PLAN_STDIO_PROFILE);
  }
  return undefined;
}

export function resolveOfficialMcpRuntimeAppRequirement(
  catalog: Pick<McpCatalogItemRecord, "source" | "slug" | "version" | "transport">,
): OfficialMcpRuntimeAppRequirement | undefined {
  if (!resolveOfficialManagedStdioProfile(catalog)) return undefined;
  if (catalog.slug === CHROME_DEVTOOLS_MCP_SLUG) {
    return { source: "clihub_public", name: "chrome-devtools-mcp", version: CHROME_DEVTOOLS_MCP_VERSION };
  }
  if (catalog.slug === MINIMAX_TOKEN_PLAN_MCP_SLUG) {
    return { source: "clihub_public", name: MINIMAX_TOKEN_PLAN_MCP_PACKAGE, version: MINIMAX_TOKEN_PLAN_MCP_VERSION };
  }
  return undefined;
}

function readOfficialReleaseOrCreate(
  workspaceId: string,
  slug: string,
  version: string,
  input: Parameters<typeof upsertMcpCatalogItemSync>[0],
): McpCatalogItemRecord {
  const existing = readMcpCatalogItemReleaseSync(slug, version, workspaceId);
  if (existing?.source === "official") return existing;
  if (existing) throw new Error("mcp_catalog.reserved_release_conflict");
  return upsertMcpCatalogItemSync(input);
}

function cloneManagedStdioProfile(profile: McpManagedStdioProfile): McpManagedStdioProfile {
  return {
    args: [...profile.args],
    managedArgs: profile.managedArgs ? [...profile.managedArgs] : undefined,
    env: { ...profile.env },
  };
}
