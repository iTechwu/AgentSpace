import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpEgressPolicySnapshot } from "@dofe-agent/domain";
import { digestMcpEgressPolicyRevision } from "@dofe-agent/services/mcp-center/egress";
import { McpEgressPolicyCache } from "./policy-cache.ts";

function snapshot(id: string, revoked = false): McpEgressPolicySnapshot {
  const revision: McpEgressPolicySnapshot["revision"] = {
      id,
      workspaceId: "ws-1",
      connectionId: "conn-1",
      releaseId: "release-1",
      manifestDigest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      upstream: {
        origin: "https://upstream.example",
        allowedHosts: ["upstream.example"],
        allowedPorts: [443],
        allowedPathPrefix: "/mcp",
      },
      transport: "streamable_http",
      redirectPolicy: "deny",
      denyPrivateNetworks: true,
      tlsMode: "verify_system",
      authMode: "none",
      maxRequestBytes: 1024,
      maxResponseBytes: 4096,
      maxConcurrentStreams: 2,
      createdAt: "2026-08-03T00:00:00Z",
    };
  return {
    revision: { ...revision, manifestDigest: digestMcpEgressPolicyRevision(revision) },
    revoked,
    fetchedAt: "2026-08-03T00:00:00Z",
  };
}

test("policy cache persists pushed snapshots and replays them on restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "dofe-egress-"));
  const stateFile = join(dir, "policy.json");

  const first = new McpEgressPolicyCache({ stateFile });
  first.set(snapshot("pol-1"));
  first.set(snapshot("pol-2"));
  first.revoke("pol-2");

  // A new cache instance from the same file = a proxy restart: the feed replays.
  const restarted = new McpEgressPolicyCache({ stateFile });
  assert.ok(restarted.get("pol-1"));
  assert.equal(restarted.get("pol-2")?.revoked, true, "revocations survive restart");
  assert.equal(restarted.list().length, 2);
  assert.ok(readFileSync(stateFile, "utf8").includes("pol-2"));
});

test("policy cache without a state file stays in-memory (no persistence)", () => {
  const cache = new McpEgressPolicyCache();
  cache.set(snapshot("pol-1"));
  assert.ok(cache.get("pol-1"));
  assert.equal(cache.list().length, 1);
});
