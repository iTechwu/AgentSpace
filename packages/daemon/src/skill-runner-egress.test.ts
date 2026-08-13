import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSkillRunnerEgressNetworkArgs,
  executeSkillRunnerWithEgressPolicy,
  isGlobalUnicastRunnerEgressAddress,
  resolveSkillRunnerEgressNetwork,
  resolveSkillRunnerEgressPlan,
  resolveSkillRunnerNetworkArgs,
  SkillRunnerEgressAddressBlockedError,
  SkillRunnerEgressOriginError,
  SkillRunnerEgressResolutionError,
} from "./skill-runner-egress.ts";
import { buildSkillRunnerDockerArgs } from "./skill-runner.ts";
import { SkillRunnerContainerCleanupError } from "./skill-runner-docker.ts";
import {
  ManagedServiceEgressPolicyError,
  type ManagedServiceEgressPolicyRuntime,
  type ManagedServiceEgressTarget,
} from "./skill-service/egress-policy.ts";

test("buildSkillRunnerEgressNetworkArgs maps the frozen grant to docker network flags", () => {
  const network = "dofe-runtime-restricted";
  // Absent / empty grant → fully isolated.
  assert.deepEqual(buildSkillRunnerEgressNetworkArgs({ network }), ["--network", "none"]);
  assert.deepEqual(buildSkillRunnerEgressNetworkArgs({ network, egressAllowlist: [] }), ["--network", "none"]);
  // Sentinel ["*"] → approved unrestricted egress on the shared network.
  assert.deepEqual(
    buildSkillRunnerEgressNetworkArgs({ network, egressAllowlist: ["*"] }),
    ["--network", network],
  );
  // Host list → DNS poison + one --add-host pin per resolved address.
  assert.deepEqual(
    buildSkillRunnerEgressNetworkArgs({
      network,
      egressAllowlist: ["api.example.com"],
      hostEntries: [
        { hostname: "api.example.com", address: "10.0.0.1" },
        { hostname: "api.example.com", address: "fc00::1" },
      ],
    }),
    ["--network", network, "--dns", "192.0.2.1", "--add-host", "api.example.com=10.0.0.1", "--add-host", "api.example.com=fc00::1"],
  );
});

test("resolveSkillRunnerEgressNetwork honors the override and rejects non-isolated defaults", () => {
  assert.equal(
    resolveSkillRunnerEgressNetwork({ DOFE_SKILL_RUNNER_EGRESS_NETWORK: "dofe-skill-egress" }),
    "dofe-skill-egress",
  );
  assert.throws(
    () => resolveSkillRunnerEgressNetwork({ DOFE_SKILL_RUNNER_EGRESS_NETWORK: "bridge" }),
    /not_isolated/,
  );
  assert.throws(
    () => resolveSkillRunnerEgressNetwork({ DOFE_SKILL_RUNNER_EGRESS_NETWORK: "bad network!" }),
    /invalid/,
  );
  // Falls back to the managed runtime network when no override is set.
  assert.equal(
    resolveSkillRunnerEgressNetwork({ MANAGED_RUNTIME_DOCKER_NETWORK: "dofe-runtime-restricted" }),
    "dofe-runtime-restricted",
  );
});

test("resolveSkillRunnerNetworkArgs fails closed when an allowlisted host does not resolve", async () => {
  await assert.rejects(
    () => resolveSkillRunnerNetworkArgs({
      egressAllowlist: ["api.example.com"],
      environment: { MANAGED_RUNTIME_DOCKER_NETWORK: "dofe-runtime-restricted" },
      lookupHost: async () => [],
    }),
    (error: unknown) => {
      assert.ok(error instanceof SkillRunnerEgressResolutionError);
      assert.equal(error.hostname, "api.example.com");
      return true;
    },
  );
});

test("resolveSkillRunnerNetworkArgs resolves allowlisted hosts into add-host pins", async () => {
  const args = await resolveSkillRunnerNetworkArgs({
    egressAllowlist: ["https://api.example.com:443", "registry.example.com"],
    environment: { MANAGED_RUNTIME_DOCKER_NETWORK: "dofe-runtime-restricted" },
    lookupHost: async (hostname) =>
      hostname === "api.example.com"
        ? [{ family: "ipv4", address: "203.0.113.10" }]
        : [{ family: "ipv4", address: "203.0.113.11" }],
  });
  assert.deepEqual(args, [
    "--network", "dofe-runtime-restricted", "--dns", "192.0.2.1",
    "--add-host", "api.example.com=203.0.113.10",
    "--add-host", "registry.example.com=203.0.113.11",
  ]);
});

test("resolveSkillRunnerNetworkArgs rejects origins DNS pinning cannot enforce", async () => {
  // Runner egress is DNS-pin only: raw IPs, localhost, private-suffix names
  // and explicit ports must fail closed, never degrade to a looser grant.
  for (const entry of ["203.0.113.10", "localhost", "db.internal", "api.example.com:8443", "https://api.example.com/v1"]) {
    await assert.rejects(
      () => resolveSkillRunnerNetworkArgs({
        egressAllowlist: [entry],
        environment: { MANAGED_RUNTIME_DOCKER_NETWORK: "dofe-runtime-restricted" },
        lookupHost: async () => [{ family: "ipv4", address: "10.0.0.1" }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof SkillRunnerEgressOriginError, entry);
        assert.equal(error.entry, entry);
        return true;
      },
    );
  }
});

test("resolveSkillRunnerEgressPlan returns firewall targets alongside the network args", async () => {
  const plan = await resolveSkillRunnerEgressPlan({
    egressAllowlist: ["api.example.com"],
    environment: { MANAGED_RUNTIME_DOCKER_NETWORK: "dofe-runtime-restricted" },
    lookupHost: async () => [{ family: "ipv4", address: "203.0.113.10" }],
  });
  assert.ok(plan);
  assert.deepEqual(plan.targets, [{
    hostname: "api.example.com",
    addresses: [{ family: "ipv4", address: "203.0.113.10" }],
  }]);
  assert.equal(plan.targets[0]!.port, undefined, "hostname grants are port-less");
  assert.ok(plan.networkArgs.includes("api.example.com=203.0.113.10"));
  assert.equal(await resolveSkillRunnerEgressPlan({ environment: {} }), undefined, "no grant → no plan");
});

test("isGlobalUnicastRunnerEgressAddress rejects inward and non-routable space", () => {
  const allowed = ["203.0.113.10", "198.51.100.1", "172.15.0.1", "172.32.0.1", "11.0.0.1", "2606:4700::1", "2001:4860:4860::8888"];
  const blocked = [
    "127.0.0.1", "10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1",
    "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "fd00::1", "ff02::1", "::ffff:203.0.113.10",
  ];
  for (const address of allowed) {
    const family = address.includes(":") ? "ipv6" as const : "ipv4" as const;
    assert.equal(isGlobalUnicastRunnerEgressAddress({ family, address }), true, `should allow ${address}`);
  }
  for (const address of blocked) {
    const family = address.includes(":") ? "ipv6" as const : "ipv4" as const;
    assert.equal(isGlobalUnicastRunnerEgressAddress({ family, address }), false, `should block ${address}`);
  }
});

test("resolveSkillRunnerEgressPlan fails closed when a hostname resolves only to inward addresses", async () => {
  const blocked = [
    { family: "ipv4" as const, address: "127.0.0.1" },
    { family: "ipv4" as const, address: "10.0.0.5" },
    { family: "ipv4" as const, address: "169.254.169.254" },
    { family: "ipv4" as const, address: "192.168.1.1" },
    { family: "ipv6" as const, address: "::1" },
    { family: "ipv6" as const, address: "fe80::1" },
    { family: "ipv6" as const, address: "fc00::1" },
  ];
  for (const candidate of blocked) {
    await assert.rejects(
      () => resolveSkillRunnerEgressPlan({
        egressAllowlist: ["api.example.com"],
        environment: { MANAGED_RUNTIME_DOCKER_NETWORK: "dofe-runtime-restricted" },
        lookupHost: async () => [candidate],
      }),
      (error: unknown) => {
        assert.ok(error instanceof SkillRunnerEgressAddressBlockedError, candidate.address);
        assert.equal(error.hostname, "api.example.com");
        return true;
      },
    );
  }
});

test("resolveSkillRunnerEgressPlan keeps only global-unicast addresses from a mixed resolution", async () => {
  const plan = await resolveSkillRunnerEgressPlan({
    egressAllowlist: ["api.example.com"],
    environment: { MANAGED_RUNTIME_DOCKER_NETWORK: "dofe-runtime-restricted" },
    lookupHost: async () => [
      { family: "ipv4", address: "203.0.113.10" },
      { family: "ipv4", address: "10.0.0.5" },
      { family: "ipv4", address: "169.254.169.254" },
      { family: "ipv6", address: "2606:4700::1" },
      { family: "ipv6", address: "fe80::1" },
    ],
  });
  assert.ok(plan);
  assert.deepEqual(plan.targets, [{
    hostname: "api.example.com",
    addresses: [
      { family: "ipv4", address: "203.0.113.10" },
      { family: "ipv6", address: "2606:4700::1" },
    ],
  }]);
  assert.ok(plan.networkArgs.includes("api.example.com=203.0.113.10"));
  assert.ok(plan.networkArgs.includes("api.example.com=2606:4700::1"));
  assert.equal(plan.networkArgs.some((arg) => arg.includes("10.0.0.5")), false);
  assert.equal(plan.networkArgs.some((arg) => arg.includes("169.254.169.254")), false);
});

/* ------------------------------------------------------------------ */
/* L3/L4 firewall execution (raw-IP / DoH bypass closed)               */
/* ------------------------------------------------------------------ */

const FIREWALL_RUN_ARGS = buildSkillRunnerDockerArgs({
  image: "registry.example.com/dofe/skill-bash@sha256:" + "c".repeat(64),
  containerName: "dofe-sr-test",
  runtime: "bash",
  artifactDir: "/daemon/cache/artifact",
  workspaceDir: "/daemon/tasks/task-1",
  outputDir: "/daemon/tasks/task-1/runtime-output/skill-runs/run",
  entrypointPath: "run.sh",
  argv: [],
  networkArgs: ["--network", "dofe-runtime-restricted", "--dns", "192.0.2.1", "--add-host", "api.example.com=203.0.113.10"],
});

const FIREWALL_TARGETS: ManagedServiceEgressTarget[] = [{
  hostname: "api.example.com",
  addresses: [{ family: "ipv4", address: "203.0.113.10" }],
}];

/** The executor's cleanup path spawns `docker rm -f` directly; point it at a
 * no-op binary so tests never depend on a host docker daemon. */
const FAKE_DOCKER_BIN = (() => {
  const dir = mkdtempSync(join(tmpdir(), "dofe-sr-fake-docker-"));
  const bin = join(dir, "docker");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return bin;
})();
const FAKE_DOCKER_ENV = { DOFE_SKILL_RUNNER_DOCKER_BIN: FAKE_DOCKER_BIN };

function fakePolicy(behavior?: { applyError?: Error }): {
  policy: ManagedServiceEgressPolicyRuntime;
  calls: Array<{ action: string; serviceId: string; targets?: ManagedServiceEgressTarget[] }>;
} {
  const calls: Array<{ action: string; serviceId: string; targets?: ManagedServiceEgressTarget[] }> = [];
  return {
    calls,
    policy: {
      async apply(input) {
        calls.push({ action: "apply", serviceId: input.serviceId, targets: input.targets });
        if (behavior?.applyError) throw behavior.applyError;
      },
      async remove(input) {
        calls.push({ action: "remove", serviceId: input.serviceId });
      },
    },
  };
}

function fakePhases(overrides?: {
  createExit?: number;
  createStderr?: string;
  inspectStdout?: string;
  inspectExit?: number;
  startResult?: { exitCode: number; stdout: string; stderr: string; timedOut: boolean };
}): (args: string[], timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return async (args) => {
    if (args[0] === "create") {
      return {
        exitCode: overrides?.createExit ?? 0,
        stdout: "container-id\n",
        stderr: overrides?.createStderr ?? "",
        timedOut: false,
      };
    }
    if (args[0] === "inspect") {
      return {
        exitCode: overrides?.inspectExit ?? 0,
        stdout: overrides?.inspectStdout ?? JSON.stringify({ "dofe-runtime-restricted": { IPAddress: "172.18.0.9" } }),
        stderr: "",
        timedOut: false,
      };
    }
    if (args[0] === "start") {
      return overrides?.startResult ?? { exitCode: 0, stdout: "skill output", stderr: "", timedOut: false };
    }
    throw new Error(`unexpected docker phase: ${args[0]}`);
  };
}

test("executeSkillRunnerWithEgressPolicy applies the chain between create and start, then removes it", async () => {
  const { policy, calls } = fakePolicy();
  const phases: string[][] = [];
  const result = await executeSkillRunnerWithEgressPolicy({
    runArgs: FIREWALL_RUN_ARGS,
    containerName: "dofe-sr-test",
    runId: "run-lease-1",
    targets: FIREWALL_TARGETS,
    policy,
    timeoutMs: 5_000,
    environment: FAKE_DOCKER_ENV,
    execute: async (args, timeoutMs) => {
      phases.push(args);
      return fakePhases()(args, timeoutMs);
    },
  });

  assert.equal(result.stdout, "skill output");
  // create must NOT carry --rm (the firewall needs the container to outlive create)
  // and keeps every other flag of the run plan.
  const createArgs = phases[0]!;
  assert.equal(createArgs[0], "create");
  assert.ok(!createArgs.includes("--rm"));
  assert.ok(createArgs.includes("--read-only"));
  assert.ok(createArgs.includes("api.example.com=203.0.113.10"));
  assert.deepEqual(phases[1]!.slice(0, 2), ["inspect", "--format"]);
  assert.deepEqual(phases[2]!, ["start", "-a", "dofe-sr-test"]);
  assert.deepEqual(calls.map((call) => call.action), ["apply", "remove"]);
  assert.equal(calls[0]!.serviceId, "run-lease-1");
  assert.deepEqual(calls[0]!.targets, FIREWALL_TARGETS);
});

test("executeSkillRunnerWithEgressPolicy fails closed when the firewall rejects the run", async () => {
  const { policy, calls } = fakePolicy({
    applyError: new ManagedServiceEgressPolicyError(
      "skill_service.egress_policy_unsupported_platform",
      "Managed service egress enforcement requires a Linux node; got darwin.",
    ),
  });
  await assert.rejects(
    () => executeSkillRunnerWithEgressPolicy({
      runArgs: FIREWALL_RUN_ARGS,
      containerName: "dofe-sr-test",
      runId: "run-lease-2",
      targets: FIREWALL_TARGETS,
      policy,
      timeoutMs: 5_000,
      environment: FAKE_DOCKER_ENV,
      execute: fakePhases(),
    }),
    (error: unknown) => error instanceof ManagedServiceEgressPolicyError,
  );
  assert.deepEqual(calls.map((call) => call.action), ["apply"],
    "a rejected apply never starts the container and has nothing to remove");
});

test("executeSkillRunnerWithEgressPolicy fails closed when Docker assigns no IP", async () => {
  const { policy, calls } = fakePolicy();
  await assert.rejects(
    () => executeSkillRunnerWithEgressPolicy({
      runArgs: FIREWALL_RUN_ARGS,
      containerName: "dofe-sr-test",
      runId: "run-lease-3",
      targets: FIREWALL_TARGETS,
      policy,
      timeoutMs: 5_000,
      environment: FAKE_DOCKER_ENV,
      execute: fakePhases({ inspectStdout: JSON.stringify({ "dofe-runtime-restricted": {} }) }),
    }),
    /skill_runner\.egress_policy_source_missing/,
  );
  assert.deepEqual(calls, [], "no source address → the firewall is never touched");
});

test("executeSkillRunnerWithEgressPolicy clears a stale container and retries create once", async () => {
  const { policy } = fakePolicy();
  let createAttempts = 0;
  const result = await executeSkillRunnerWithEgressPolicy({
    runArgs: FIREWALL_RUN_ARGS,
    containerName: "dofe-sr-test",
    runId: "run-lease-4",
    targets: FIREWALL_TARGETS,
    policy,
    timeoutMs: 5_000,
    environment: FAKE_DOCKER_ENV,
    execute: async (args, timeoutMs) => {
      if (args[0] === "create") {
        createAttempts += 1;
        if (createAttempts === 1) {
          return { exitCode: 1, stdout: "", stderr: `Error response from daemon: Conflict. The container name "/dofe-sr-test" is already in use`, timedOut: false };
        }
      }
      return fakePhases()(args, timeoutMs);
    },
  });
  assert.equal(createAttempts, 2);
  assert.equal(result.exitCode, 0);
});

test("executeSkillRunnerWithEgressPolicy propagates a hard create failure without retry", async () => {
  const { policy, calls } = fakePolicy();
  let createAttempts = 0;
  await assert.rejects(
    () => executeSkillRunnerWithEgressPolicy({
      runArgs: FIREWALL_RUN_ARGS,
      containerName: "dofe-sr-test",
      runId: "run-lease-5",
      targets: FIREWALL_TARGETS,
      policy,
      timeoutMs: 5_000,
      environment: FAKE_DOCKER_ENV,
      execute: async (args, timeoutMs) => {
        if (args[0] === "create") {
          createAttempts += 1;
          return { exitCode: 1, stdout: "", stderr: "permission denied", timedOut: false };
        }
        return fakePhases()(args, timeoutMs);
      },
    }),
    /skill_runner\.container_create_failed: permission denied/,
  );
  assert.equal(createAttempts, 1);
  assert.deepEqual(calls, []);
});

test("executeSkillRunnerWithEgressPolicy keeps the firewall applied when container removal fails (fail-closed)", async () => {
  // Regression: cleanup must remove the container BEFORE revoking the firewall.
  // If `docker rm -f` fails, the policy stays applied so a still-running
  // container never escapes to an unrestricted DOCKER-USER chain.
  const { policy, calls } = fakePolicy();
  const failingDockerBin = (() => {
    const dir = mkdtempSync(join(tmpdir(), "dofe-sr-fail-docker-"));
    const bin = join(dir, "docker");
    // `rm -f` exits non-zero without the "no such container" sentinel → reject.
    writeFileSync(bin, "#!/bin/sh\nif [ \"$1\" = \"rm\" ]; then echo 'device or resource busy' >&2; exit 1; fi\nexit 0\n", { mode: 0o755 });
    return bin;
  })();
  await assert.rejects(
    () => executeSkillRunnerWithEgressPolicy({
      runArgs: FIREWALL_RUN_ARGS,
      containerName: "dofe-sr-fail",
      runId: "run-lease-fail",
      targets: FIREWALL_TARGETS,
      policy,
      timeoutMs: 5_000,
      environment: { DOFE_SKILL_RUNNER_DOCKER_BIN: failingDockerBin },
      execute: fakePhases(),
    }),
    (error: unknown) => {
      assert.ok(error instanceof SkillRunnerContainerCleanupError, "container cleanup error must propagate");
      return true;
    },
  );
  assert.deepEqual(calls.map((call) => call.action), ["apply"],
    "policy.remove must NOT run while the container may still be alive — the firewall stays applied");
});
