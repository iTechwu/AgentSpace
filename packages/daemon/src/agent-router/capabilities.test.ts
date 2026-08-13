import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeToolCapability } from "@dofe-agent/domain";
import {
  buildCapabilityAllowedTools,
  buildCapabilityEnv,
  buildCapabilityPathDirs,
} from "./capabilities.ts";

function buildCapability(overrides: Partial<RuntimeToolCapability> = {}): RuntimeToolCapability {
  return {
    id: "cap-curl",
    command: "curl",
    source: "runtime",
    ...overrides,
  };
}

test("buildCapabilityAllowedTools emits Bash(pattern) for approved capabilities", () => {
  const tools = buildCapabilityAllowedTools([buildCapability()]);
  assert.deepEqual(tools, ["Bash(curl *)"]);
});

test("buildCapabilityAllowedTools fail-closes on requiresApproval (no Bash grant)", () => {
  const tools = buildCapabilityAllowedTools([buildCapability({ requiresApproval: true })]);
  assert.deepEqual(tools, [], "an unapproved capability must not yield any Bash(...) permission");
});

test("buildCapabilityAllowedTools still skips denied capabilities", () => {
  const tools = buildCapabilityAllowedTools([
    buildCapability({ status: "denied", denialReason: "no grant" }),
  ]);
  assert.deepEqual(tools, []);
});

test("buildCapabilityAllowedTools treats requiresApproval:false/undefined as approved", () => {
  assert.deepEqual(buildCapabilityAllowedTools([buildCapability({ requiresApproval: false })]), [
    "Bash(curl *)",
  ]);
  assert.deepEqual(buildCapabilityAllowedTools([buildCapability({ requiresApproval: undefined })]), [
    "Bash(curl *)",
  ]);
});

test("buildCapabilityPathDirs fail-closes on requiresApproval (no PATH injection)", () => {
  const approved = buildCapabilityPathDirs([
    buildCapability({ binPath: "/usr/bin/curl", pathDirs: ["/opt/bin"] }),
  ]);
  assert.ok(approved.includes("/usr/bin"));
  assert.ok(approved.includes("/opt/bin"));

  const unapproved = buildCapabilityPathDirs([
    buildCapability({ requiresApproval: true, binPath: "/usr/bin/curl", pathDirs: ["/opt/bin"] }),
  ]);
  assert.deepEqual(unapproved, [], "an unapproved capability must not contribute PATH dirs");
});

test("buildCapabilityEnv fail-closes on requiresApproval (no env injection)", () => {
  const approved = buildCapabilityEnv({ PATH: "/x" }, [
    buildCapability({ env: { CURL_HOME: "/data" } }),
  ]);
  assert.equal(approved.CURL_HOME, "/data");

  const unapproved = buildCapabilityEnv({ PATH: "/x" }, [
    buildCapability({ requiresApproval: true, env: { CURL_HOME: "/data" } }),
  ]);
  assert.equal(
    unapproved.CURL_HOME,
    undefined,
    "an unapproved capability must not inject env vars",
  );
  assert.equal(unapproved.PATH, "/x", "base env is preserved unchanged");
});
