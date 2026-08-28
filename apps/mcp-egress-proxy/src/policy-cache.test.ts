import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
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
      releaseManifestDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
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
      maxRequestsPerSecond: 8,
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

test("policy cache never persists authentication material or grant references", () => {
  const dir = mkdtempSync(join(tmpdir(), "dofe-egress-secrets-"));
  const stateFile = join(dir, "policy.json");
  const cache = new McpEgressPolicyCache({ stateFile });
  cache.set({
    ...snapshot("pol-secret"),
    staticHeaders: { Authorization: "Bearer must-not-persist" },
    oauthGrantReference: "grant-must-not-persist",
    privateCaPem: "must-not-persist-private-ca",
  });

  const stored = readFileSync(stateFile, "utf8");
  assert.doesNotMatch(stored, /must-not-persist|Authorization|privateCaPem|oauthGrantReference/);
  assert.equal(new McpEgressPolicyCache({ stateFile }).get("pol-secret")?.staticHeaders, undefined);
  assert.equal(new McpEgressPolicyCache({ stateFile }).get("pol-secret")?.privateCaPem, undefined);
  assert.equal(new McpEgressPolicyCache({ stateFile }).get("pol-secret")?.oauthGrantReference, undefined);
  assert.equal(cache.get("pol-secret")?.staticHeaders?.Authorization, "Bearer must-not-persist");
});

test("policy cache without a state file stays in-memory (no persistence)", () => {
  const cache = new McpEgressPolicyCache();
  cache.set(snapshot("pol-1"));
  assert.ok(cache.get("pol-1"));
  assert.equal(cache.list().length, 1);
});

test("policy revocation is monotonic across stale pushes", () => {
  const cache = new McpEgressPolicyCache();
  cache.set(snapshot("pol-revoked"));
  cache.revoke("pol-revoked");
  cache.set(snapshot("pol-revoked", false));

  assert.equal(cache.get("pol-revoked")?.revoked, true);
});

test("an out-of-order revocation tombstone survives push and restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "dofe-egress-tombstone-"));
  const stateFile = join(dir, "policy.json");
  const first = new McpEgressPolicyCache({ stateFile });
  first.revoke("pol-late");
  first.set(snapshot("pol-late", false));
  assert.equal(first.get("pol-late")?.revoked, true);

  const restarted = new McpEgressPolicyCache({ stateFile });
  restarted.set(snapshot("pol-late", false));
  assert.equal(restarted.get("pol-late")?.revoked, true);
});

test("corrupt policy state fails proxy startup instead of discarding deny state", () => {
  const stateFile = join(mkdtempSync(join(tmpdir(), "dofe-egress-policy-corrupt-")), "policy.json");
  writeFileSync(stateFile, "{", "utf8");
  assert.throws(() => new McpEgressPolicyCache({ stateFile }), /state file is unreadable/);
});

test("failed persistence does not commit policy or revocation changes in memory", () => {
  const root = mkdtempSync(join(tmpdir(), "dofe-egress-policy-write-failure-"));
  const stateDirectory = join(root, "state");
  const stateFile = join(stateDirectory, "policy.json");
  const cache = new McpEgressPolicyCache({ stateFile });
  cache.set(snapshot("pol-existing", false));

  unlinkSync(stateFile);
  rmdirSync(stateDirectory);
  writeFileSync(stateDirectory, "blocks state directory recreation", "utf8");

  assert.throws(() => cache.set(snapshot("pol-uncommitted", false)));
  assert.equal(cache.get("pol-uncommitted"), undefined);

  assert.throws(() => cache.revoke("pol-existing"));
  assert.equal(cache.get("pol-existing")?.revoked, false);
});
