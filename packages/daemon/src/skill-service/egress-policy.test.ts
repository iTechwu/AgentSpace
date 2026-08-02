import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildManagedServiceEgressChainName,
  createIptablesManagedServiceEgressPolicy,
  parseManagedServiceEgressTargets,
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
