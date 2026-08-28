import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildManagedServiceEgressChainName,
  createIptablesManagedServiceEgressPolicy,
  parseManagedServiceEgressTargets,
  sweepPersistedEgressPolicies,
  type ManagedFirewallExec,
} from "./egress-policy.ts";

test("parseManagedServiceEgressTargets fixes scheme, host and port", () => {
  assert.deepEqual(parseManagedServiceEgressTargets([
    "https://api.example.com",
    "http://status.example.com:8080",
    "registry.example.com:8443",
    "[2001:db8::1]:443",
  ]), [
    { hostname: "api.example.com", port: 443 },
    { hostname: "status.example.com", port: 8080 },
    { hostname: "registry.example.com", port: 8443 },
    { hostname: "2001:db8::1", port: 443 },
  ]);
  assert.throws(() => parseManagedServiceEgressTargets(["ftp://example.com"]), /protocol/i);
  assert.throws(() => parseManagedServiceEgressTargets(["https://example.com/path"]), /origin/i);
  assert.throws(() => parseManagedServiceEgressTargets(["https://user:pass@example.com"]), /credentials/i);
});

test("iptables policy allows only exact IP and TCP port before a final drop", async () => {
  const stateRootDir = await fs.mkdtemp(join(tmpdir(), "dofe-egress-policy-"));
  const calls: Array<{ family: "ipv4" | "ipv6"; args: string[] }> = [];
  const exec: ManagedFirewallExec = async (family, args) => {
    calls.push({ family, args });
    return { stdout: "", stderr: "", exitCode: args[2] === "-C" ? 1 : 0 };
  };
  const policy = createIptablesManagedServiceEgressPolicy({ exec, stateRootDir, platform: "linux" });
  try {
    await policy.apply({
      serviceId: "svc-1",
      sourceAddresses: [
        { family: "ipv4", address: "172.18.0.4" },
        { family: "ipv6", address: "fd00::4" },
      ],
      targets: [{
        hostname: "api.example.com",
        port: 443,
        addresses: [
          { family: "ipv4", address: "203.0.113.10" },
          { family: "ipv6", address: "2001:db8::10" },
        ],
      }],
    });

    const chain = buildManagedServiceEgressChainName("svc-1");
    assert.ok(calls.some(({ family, args }) => family === "ipv4"
      && args.join(" ") === `-w 5 -A ${chain} -d 203.0.113.10/32 -p tcp --dport 443 -j RETURN`));
    assert.ok(calls.some(({ family, args }) => family === "ipv6"
      && args.join(" ") === `-w 5 -A ${chain} -d 2001:db8::10/128 -p tcp --dport 443 -j RETURN`));
    assert.ok(calls.some(({ args }) => args.join(" ") === `-w 5 -A ${chain} -j DROP`));
    assert.ok(calls.some(({ family, args }) => family === "ipv4"
      && args.join(" ") === `-w 5 -I DOCKER-USER 1 -s 172.18.0.4/32 -j ${chain}`));

    calls.length = 0;
    await policy.remove({ serviceId: "svc-1" });
    assert.ok(calls.some(({ args }) => args.includes("-D") && args.includes("DOCKER-USER")));
    assert.ok(calls.some(({ args }) => args.includes("-X") && args.includes(chain)));
  } finally {
    await fs.rm(stateRootDir, { recursive: true, force: true });
  }
});

test("a Skill Runner hostname grant (default port 443) emits a precise --dport rule, not any-port", async () => {
  const stateRootDir = await fs.mkdtemp(join(tmpdir(), "dofe-egress-policy-"));
  const calls: Array<{ family: "ipv4" | "ipv6"; args: string[] }> = [];
  const exec: ManagedFirewallExec = async (family, args) => {
    calls.push({ family, args });
    return { stdout: "", stderr: "", exitCode: args[2] === "-C" ? 1 : 0 };
  };
  const policy = createIptablesManagedServiceEgressPolicy({ exec, stateRootDir, platform: "linux" });
  try {
    await policy.apply({
      serviceId: "run-1",
      sourceAddresses: [{ family: "ipv4", address: "172.18.0.6" }],
      targets: [{
        hostname: "api.example.com",
        port: 443,
        addresses: [{ family: "ipv4", address: "203.0.113.10" }],
      }],
    });
    const chain = buildManagedServiceEgressChainName("run-1");
    assert.ok(calls.some(({ family, args }) => family === "ipv4"
      && args.join(" ") === `-w 5 -A ${chain} -d 203.0.113.10/32 -p tcp --dport 443 -j RETURN`),
      "the default port is enforced: only 443 to the resolved address");
    assert.ok(!calls.some(({ family, args }) => family === "ipv4"
      && args.join(" ") === `-w 5 -A ${chain} -d 203.0.113.10/32 -p tcp -j RETURN`),
      "no any-port RETURN rule: a bare-hostname grant must not open every TCP port");
    assert.ok(calls.some(({ args }) => args.join(" ") === `-w 5 -A ${chain} -j DROP`),
      "everything else — other ports, raw IPs, DoH endpoints — is dropped");
  } finally {
    await fs.rm(stateRootDir, { recursive: true, force: true });
  }
});

test("sweepPersistedEgressPolicies removes every persisted policy and ignores junk", async () => {
  const stateRootDir = await fs.mkdtemp(join(tmpdir(), "dofe-egress-sweep-"));
  const calls: string[][] = [];
  const exec: ManagedFirewallExec = async (_family, args) => {
    calls.push(args);
    return { stdout: "", stderr: "", exitCode: args[2] === "-C" ? 1 : 0 };
  };
  const policy = createIptablesManagedServiceEgressPolicy({ exec, stateRootDir, platform: "linux" });
  try {
    await policy.apply({
      serviceId: "stale-run",
      sourceAddresses: [{ family: "ipv4", address: "172.18.0.7" }],
      targets: [],
    });
    await fs.writeFile(join(stateRootDir, "broken.json"), "not-json", "utf8");
    await fs.writeFile(join(stateRootDir, "notes.txt"), "ignored", "utf8");

    const result = await sweepPersistedEgressPolicies(stateRootDir, policy);
    assert.equal(result.removed, 1);
    assert.equal(result.kept, 0);
    assert.equal(result.enumerationFailed, false);
    const chain = buildManagedServiceEgressChainName("stale-run");
    assert.ok(calls.some((args) => args.includes("-D") && args.includes("DOCKER-USER") && args.includes(chain)));
    assert.deepEqual(await fs.readdir(stateRootDir), ["broken.json", "notes.txt"],
      "sweep removes only valid policy state files");
  } finally {
    await fs.rm(stateRootDir, { recursive: true, force: true });
  }
});

test("sweepPersistedEgressPolicies keeps the firewall of a still-running owner and reclaims only stale ones", async () => {
  const stateRootDir = await fs.mkdtemp(join(tmpdir(), "dofe-egress-sweep-live-"));
  const removed: string[] = [];
  const policy = {
    async apply() { /* not exercised */ },
    async remove(input: { serviceId: string }) { removed.push(input.serviceId); },
  };
  try {
    await fs.writeFile(
      join(stateRootDir, "live.json"),
      JSON.stringify({ serviceId: "live-run", sourceAddresses: [{ family: "ipv4", address: "172.18.0.10" }] }),
      "utf8",
    );
    await fs.writeFile(
      join(stateRootDir, "dead.json"),
      JSON.stringify({ serviceId: "dead-run", sourceAddresses: [{ family: "ipv4", address: "172.18.0.11" }] }),
      "utf8",
    );
    // Only "live-run" still has a running container.
    const result = await sweepPersistedEgressPolicies(stateRootDir, policy, {
      enumerateLivePolicyOwners: async () => new Set(["live-run"]),
    });
    assert.deepEqual(removed, ["dead-run"], "only the dead owner's policy is revoked");
    assert.equal(result.removed, 1);
    assert.equal(result.kept, 1);
    assert.equal(result.enumerationFailed, false);
  } finally {
    await fs.rm(stateRootDir, { recursive: true, force: true });
  }
});

test("sweepPersistedEgressPolicies keeps everything and reports enumerationFailed when the live-owner probe errors", async () => {
  const stateRootDir = await fs.mkdtemp(join(tmpdir(), "dofe-egress-sweep-fail-"));
  const removed: string[] = [];
  const policy = {
    async apply() { /* not exercised */ },
    async remove(input: { serviceId: string }) { removed.push(input.serviceId); },
  };
  try {
    await fs.writeFile(
      join(stateRootDir, "a.json"),
      JSON.stringify({ serviceId: "run-a", sourceAddresses: [{ family: "ipv4", address: "172.18.0.20" }] }),
      "utf8",
    );
    await fs.writeFile(
      join(stateRootDir, "b.json"),
      JSON.stringify({ serviceId: "run-b", sourceAddresses: [{ family: "ipv4", address: "172.18.0.21" }] }),
      "utf8",
    );
    // Enumeration fails (e.g. docker unreachable): must NOT revoke anything —
    // the safe direction keeps every chain (default DROP), and the caller is
    // told to retry rather than cache the sweep as complete.
    const result = await sweepPersistedEgressPolicies(stateRootDir, policy, {
      enumerateLivePolicyOwners: async () => { throw new Error("docker ps failed"); },
    });
    assert.deepEqual(removed, [], "nothing is revoked when liveness cannot be established");
    assert.equal(result.removed, 0);
    assert.equal(result.kept, 2);
    assert.equal(result.enumerationFailed, true);
  } finally {
    await fs.rm(stateRootDir, { recursive: true, force: true });
  }
});

test("sweepPersistedEgressPolicies surfaces removalFailed (not success) when a remove throws and leaves the candidate retryable", async () => {
  // Regression: a single-item remove failure used to be swallowed and the sweep
  // returned success (enumerationFailed:false, no removalFailed signal). The
  // caller then cached the sweep as done, so the stale chain was never retried.
  // The fix counts the failure so the caller drops its cache. Faithful to the
  // real remove() contract, the mock deletes the state file ONLY on success —
  // a failed teardown leaves it on disk so the next sweep retries the candidate.
  const stateRootDir = await fs.mkdtemp(join(tmpdir(), "dofe-egress-sweep-flaky-"));
  const removed: string[] = [];
  const policy = {
    async apply() { /* not exercised */ },
    async remove(input: { serviceId: string }) {
      if (input.serviceId === "flaky-run") {
        throw new Error("firewall teardown failed");
      }
      removed.push(input.serviceId);
      await fs.unlink(join(stateRootDir, `${input.serviceId}.json`)).catch(() => undefined);
    },
  };
  try {
    await fs.writeFile(
      join(stateRootDir, "dead-run.json"),
      JSON.stringify({ serviceId: "dead-run", sourceAddresses: [{ family: "ipv4", address: "172.18.0.30" }] }),
      "utf8",
    );
    await fs.writeFile(
      join(stateRootDir, "flaky-run.json"),
      JSON.stringify({ serviceId: "flaky-run", sourceAddresses: [{ family: "ipv4", address: "172.18.0.31" }] }),
      "utf8",
    );

    const result = await sweepPersistedEgressPolicies(stateRootDir, policy, {
      enumerateLivePolicyOwners: async () => new Set(),
    });
    assert.deepEqual(removed, ["dead-run"], "the healthy candidate is revoked");
    assert.equal(result.removed, 1);
    assert.equal(result.removalFailed, 1, "the flaky candidate's remove failure is surfaced, not swallowed");
    assert.equal(result.enumerationFailed, false, "a remove failure is not an enumeration failure");
    const remaining = await fs.readdir(stateRootDir);
    assert.ok(remaining.includes("flaky-run.json"), "the flaky candidate's state survives so the next sweep retries it");
    assert.ok(!remaining.includes("dead-run.json"), "the revoked candidate's state is gone");
  } finally {
    await fs.rm(stateRootDir, { recursive: true, force: true });
  }
});

test("empty allow-list installs a drop-only chain", async () => {
  const stateRootDir = await fs.mkdtemp(join(tmpdir(), "dofe-egress-policy-"));
  const calls: string[][] = [];
  const exec: ManagedFirewallExec = async (_family, args) => {
    calls.push(args);
    return { stdout: "", stderr: "", exitCode: args[2] === "-C" ? 1 : 0 };
  };
  const policy = createIptablesManagedServiceEgressPolicy({ exec, stateRootDir, platform: "linux" });
  try {
    await policy.apply({
      serviceId: "svc-zero",
      sourceAddresses: [{ family: "ipv4", address: "172.18.0.5" }],
      targets: [],
    });
    const chain = buildManagedServiceEgressChainName("svc-zero");
    const chainRules = calls.filter((args) => args[2] === "-A" && args[3] === chain);
    assert.deepEqual(chainRules.at(-1), ["-w", "5", "-A", chain, "-j", "DROP"]);
    assert.equal(chainRules.some((args) => args.includes("--dport")), false);
  } finally {
    await fs.rm(stateRootDir, { recursive: true, force: true });
  }
});

test("policy fails closed outside Linux and when firewall programming fails", async () => {
  const stateRootDir = await fs.mkdtemp(join(tmpdir(), "dofe-egress-policy-"));
  try {
    const unsupported = createIptablesManagedServiceEgressPolicy({
      stateRootDir,
      platform: "darwin",
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    });
    await assert.rejects(
      unsupported.apply({
        serviceId: "svc-1",
        sourceAddresses: [{ family: "ipv4", address: "172.18.0.4" }],
        targets: [],
      }),
      /egress_policy_unsupported_platform/,
    );

    const denied = createIptablesManagedServiceEgressPolicy({
      stateRootDir,
      platform: "linux",
      exec: async () => ({ stdout: "", stderr: "permission denied", exitCode: 4 }),
    });
    await assert.rejects(
      denied.apply({
        serviceId: "svc-2",
        sourceAddresses: [{ family: "ipv4", address: "172.18.0.5" }],
        targets: [],
      }),
      /egress_policy_apply_failed/,
    );
  } finally {
    await fs.rm(stateRootDir, { recursive: true, force: true });
  }
});

test("retire reports firewall permission failures instead of discarding policy state", async () => {
  const stateRootDir = await fs.mkdtemp(join(tmpdir(), "dofe-egress-policy-"));
  let denyCleanup = false;
  const exec: ManagedFirewallExec = async (_family, args) => ({
    stdout: "",
    stderr: denyCleanup && args[2] === "-D" ? "permission denied" : "",
    exitCode: denyCleanup && args[2] === "-D" ? 4 : args[2] === "-C" ? 1 : 0,
  });
  const policy = createIptablesManagedServiceEgressPolicy({ exec, stateRootDir, platform: "linux" });
  try {
    await policy.apply({
      serviceId: "svc-cleanup",
      sourceAddresses: [{ family: "ipv4", address: "172.18.0.7" }],
      targets: [],
    });
    denyCleanup = true;
    await assert.rejects(
      policy.remove({ serviceId: "svc-cleanup" }),
      /egress_policy_remove_failed.*permission denied/,
    );
    assert.equal((await fs.readdir(stateRootDir)).length, 1, "state must remain for an operator retry");
  } finally {
    await fs.rm(stateRootDir, { recursive: true, force: true });
  }
});
