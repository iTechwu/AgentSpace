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

export function syncOfficialMcpCatalogForWorkspaceSync(workspaceId: string): McpCatalogItemRecord {
  const syncedAt = new Date().toISOString();
  upsertRuntimeAppCatalogItemsSync([{
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
  }]);

  const existing = readMcpCatalogItemReleaseSync(CHROME_DEVTOOLS_MCP_SLUG, CHROME_DEVTOOLS_MCP_VERSION, workspaceId);
  if (existing?.source === "official") return existing;
  if (existing) throw new Error("mcp_catalog.reserved_release_conflict");

  return upsertMcpCatalogItemSync({
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
}

export function resolveOfficialManagedStdioProfile(
  catalog: Pick<McpCatalogItemRecord, "source" | "slug" | "version" | "transport">,
): McpManagedStdioProfile | undefined {
  if (
    catalog.source !== "official" ||
    catalog.slug !== CHROME_DEVTOOLS_MCP_SLUG ||
    catalog.version !== CHROME_DEVTOOLS_MCP_VERSION ||
    catalog.transport !== "managed_stdio"
  ) return undefined;
  return {
    args: [...CHROME_DEVTOOLS_STDIO_PROFILE.args],
    managedArgs: [...(CHROME_DEVTOOLS_STDIO_PROFILE.managedArgs ?? [])],
    env: { ...CHROME_DEVTOOLS_STDIO_PROFILE.env },
  };
}

export function resolveOfficialMcpRuntimeAppRequirement(
  catalog: Pick<McpCatalogItemRecord, "source" | "slug" | "version" | "transport">,
): OfficialMcpRuntimeAppRequirement | undefined {
  return resolveOfficialManagedStdioProfile(catalog)
    ? { source: "clihub_public", name: "chrome-devtools-mcp", version: CHROME_DEVTOOLS_MCP_VERSION }
    : undefined;
}
