import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_GATEWAY_SERVER_KEY,
  buildClaudeMcpGatewayArgs,
  buildClaudeMcpServerArgs,
  buildCodexMcpGatewayArgs,
  buildCodexMcpServerArgs,
  mcpGatewayUrlRedactions,
  shouldInjectCodexMcpGateway,
} from "./mcp-gateway.ts";
import { redactText } from "./utils.ts";

const GATEWAY_URL = "http://127.0.0.1:39821/mcp?session=abc123def456";

test("buildClaudeMcpGatewayArgs emits a strict --mcp-config JSON pointing at the gateway", () => {
  const { args } = buildClaudeMcpGatewayArgs(GATEWAY_URL);
  assert.deepEqual(args, ["--mcp-config", JSON.stringify({
    mcpServers: {
      [MCP_GATEWAY_SERVER_KEY]: { type: "http", url: GATEWAY_URL },
    },
  }), "--strict-mcp-config"]);

  const config = JSON.parse(args[1]!) as {
    mcpServers: Record<string, { type: string; url: string }>;
  };
  assert.equal(config.mcpServers[MCP_GATEWAY_SERVER_KEY]?.type, "http");
  assert.equal(config.mcpServers[MCP_GATEWAY_SERVER_KEY]?.url, GATEWAY_URL);
});

test("buildCodexMcpGatewayArgs replaces the whole mcp_servers key with only the gateway", () => {
  const { args } = buildCodexMcpGatewayArgs(GATEWAY_URL);
  assert.equal(args.length, 2);
  assert.equal(args[0], "--config");

  // Replacing the whole mcp_servers key (not appending one server) is the
  // strongest available isolation: any MCP server a user/project configured in
  // a lower config layer is not carried into the task. codex splits the
  // override on the FIRST '=' only; the inner `= { … }` stays intact.
  const override = args[1]!;
  assert.equal(
    override,
    `mcp_servers={ "${MCP_GATEWAY_SERVER_KEY}" = { url = "${GATEWAY_URL}", startup_timeout_sec = 30 } }`,
  );
  assert.equal(override.startsWith("mcp_servers={ "), true);
  assert.equal(override.includes(`"${MCP_GATEWAY_SERVER_KEY}"`), true);
  // URL with ?session= query survives verbatim inside the TOML string.
  assert.equal(override.includes("?session=abc123def456"), true);
});

test("both builders redact the gateway URL (which carries the session token)", () => {
  for (const injection of [buildClaudeMcpGatewayArgs(GATEWAY_URL), buildCodexMcpGatewayArgs(GATEWAY_URL)]) {
    assert.equal(injection.redactions.length, 1);
    const leaked = `called ${GATEWAY_URL} and failed`;
    assert.equal(redactText(leaked, injection.redactions).includes(GATEWAY_URL), false);
    assert.equal(redactText(leaked, injection.redactions).includes("session=abc123def456"), false);
    assert.equal(redactText(leaked, injection.redactions).includes("[redacted:mcp-gateway-url]"), true);
  }
});

test("mcpGatewayUrlRedactions is empty for an empty url and does not throw", () => {
  assert.deepEqual(mcpGatewayUrlRedactions(""), []);
});

test("shouldInjectCodexMcpGateway honors the experiment switch", () => {
  assert.equal(shouldInjectCodexMcpGateway({ mcpGatewayUrl: GATEWAY_URL }), false, "defaults to disabled until explicitly enabled");
  assert.equal(shouldInjectCodexMcpGateway({ mcpGatewayUrl: GATEWAY_URL, codexMcpInjectionEnabled: false }), false, "kill switch disables injection");
  assert.equal(shouldInjectCodexMcpGateway({}), false, "no URL → no injection");
  assert.equal(shouldInjectCodexMcpGateway({ mcpGatewayUrl: GATEWAY_URL, codexMcpInjectionEnabled: true }), true);
});

test("multi-server ToolSurface builders preserve independent endpoints and non-secret headers", () => {
  const servers = [
    { name: "mcp_github", url: "https://github.example/mcp", headers: { "X-Tenant": "acme" } },
    { name: "mcp_search", url: "http://search.internal/mcp" },
  ];
  const claude = buildClaudeMcpServerArgs(servers);
  const config = JSON.parse(claude.args[1]!) as { mcpServers: Record<string, { url: string; headers?: Record<string, string> }> };
  assert.equal(config.mcpServers.mcp_github?.url, servers[0]!.url);
  assert.deepEqual(config.mcpServers.mcp_github?.headers, { "X-Tenant": "acme" });
  assert.equal(config.mcpServers.mcp_search?.url, servers[1]!.url);
  assert.equal(claude.redactions.length, 2);

  const codex = buildCodexMcpServerArgs(servers);
  assert.match(codex.args[1]!, /mcp_github/);
  assert.match(codex.args[1]!, /http_headers/);
  assert.match(codex.args[1]!, /http_headers = \{ "X-Tenant" = "acme" \}/);
  assert.doesNotMatch(codex.args[1]!, /\{"X-Tenant":"acme"\}/);
  assert.equal(codex.redactions.length, 2);
});
