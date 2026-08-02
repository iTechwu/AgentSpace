import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_GATEWAY_SERVER_KEY,
  buildClaudeMcpGatewayArgs,
  buildCodexMcpGatewayArgs,
  mcpGatewayUrlRedactions,
} from "./mcp-gateway.ts";
import { redactText } from "./utils.ts";

const GATEWAY_URL = "http://127.0.0.1:39821/mcp?session=abc123def456";

test("buildClaudeMcpGatewayArgs emits a strict --mcp-config JSON pointing at the gateway", () => {
  const { args } = buildClaudeMcpGatewayArgs(GATEWAY_URL);
  assert.deepEqual(args, ["--mcp-config", JSON.stringify({
    [MCP_GATEWAY_SERVER_KEY]: { type: "http", url: GATEWAY_URL },
  }), "--strict-mcp-config"]);

  const config = JSON.parse(args[1]!) as Record<string, { type: string; url: string }>;
  assert.equal(config[MCP_GATEWAY_SERVER_KEY]?.type, "http");
  assert.equal(config[MCP_GATEWAY_SERVER_KEY]?.url, GATEWAY_URL);
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
