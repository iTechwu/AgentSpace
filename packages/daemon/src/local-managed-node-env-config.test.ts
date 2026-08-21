import assert from "node:assert/strict";
import test from "node:test";
import { resolveManagedNodeOperationalEnv } from "../../../deploy/daemon/local-managed-node-env-config.ts";

const REQUIRED_PROXY_ENV = {
  MCP_EGRESS_PROXY_URL: "http://127.0.0.1:18080",
  MCP_EGRESS_PROXY_ADMIN_TOKEN: "test-token",
};

test("managed-node operational env preserves the Tools viral-video MCP endpoint", () => {
  const resolved = resolveManagedNodeOperationalEnv("", {
    ...REQUIRED_PROXY_ENV,
    TOOLS_VIRAL_VIDEO_MCP_URL: "http://127.0.0.1:13103/mcp/viral-video",
  });

  assert.equal(
    resolved.TOOLS_VIRAL_VIDEO_MCP_URL,
    "http://127.0.0.1:13103/mcp/viral-video",
  );
});

test("managed-node operational env rejects a Tools endpoint outside the viral-video MCP path", () => {
  assert.throws(() => resolveManagedNodeOperationalEnv("", {
    ...REQUIRED_PROXY_ENV,
    TOOLS_VIRAL_VIDEO_MCP_URL: "http://127.0.0.1:13103/mcp/platform",
  }), /TOOLS_VIRAL_VIDEO_MCP_URL/);
});
