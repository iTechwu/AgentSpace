import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { getDaemonSkillInstallCachePath } from "@dofe-agent/db";
import {
  buildSkillRunnerDockerArgs,
  buildSkillRunnerEgressNetworkArgs,
  buildSkillRunnerSystemProbeDockerArgs,
  executeSkillRunnerWithEgressPolicy,
  resolveSkillRunnerEgressNetwork,
  resolveSkillRunnerEgressPlan,
  resolveSkillRunnerNetworkArgs,
  SkillRunnerEgressResolutionError,
  SkillRunnerEgressOriginError,
  startSkillRunnerBroker,
} from "./skill-runner.ts";
import {
  ManagedServiceEgressPolicyError,
  type ManagedServiceEgressPolicyRuntime,
  type ManagedServiceEgressTarget,
} from "./skill-service/egress-policy.ts";

const execFileAsync = promisify(execFile);

test("buildSkillRunnerDockerArgs creates a non-root, read-only and networkless execution", () => {
  const args = buildSkillRunnerDockerArgs({
    image: "registry.example.com/dofe/skill-node@sha256:" + "a".repeat(64),
    runtime: "node",
    artifactDir: "/daemon/cache/artifact",
    workspaceDir: "/daemon/tasks/task-1",
    outputDir: "/daemon/tasks/task-1/runtime-output/skill-runs/render",
    entrypointPath: "scripts/render.mjs",
    argv: ["--title", "hello; rm -rf /"],
  });

  assert.deepEqual(args.slice(0, 14), [
    "run", "--rm", "--init", "--pull", "never", "--read-only", "--network", "none",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65532:65532",
  ]);
  assert.ok(args.includes("/tmp:rw,nosuid,nodev,noexec,size=32m"));
  assert.ok(args.includes("type=bind,src=/daemon/cache/artifact,dst=/skill,readonly"));
  assert.ok(args.includes("type=bind,src=/daemon/tasks/task-1,dst=/workspace,readonly"));
  assert.ok(args.includes("type=bind,src=/daemon/tasks/task-1/runtime-output/skill-runs/render,dst=/output"));
  assert.deepEqual(args.slice(-5), [
    "registry.example.com/dofe/skill-node@sha256:" + "a".repeat(64),
    "node", "/skill/scripts/render.mjs", "--title", "hello; rm -rf /",
  ]);
  assert.equal(args.includes("sh"), false);
});

test("buildSkillRunnerDockerArgs mounts the installation dependency environment read-only", () => {
  const args = buildSkillRunnerDockerArgs({
    image: "registry.example.com/dofe/skill-python@sha256:" + "b".repeat(64),
    runtime: "python",
    artifactDir: "/daemon/cache/artifact",
    dependencyDir: "/daemon/envs/installation-1",
    workspaceDir: "/daemon/tasks/task-1",
    outputDir: "/daemon/tasks/task-1/runtime-output/skill-runs/analyze",
    entrypointPath: "scripts/analyze.py",
    argv: [],
  });

  assert.ok(args.includes("type=bind,src=/daemon/envs/installation-1,dst=/deps,readonly"));
  assert.ok(args.includes("NODE_PATH=/deps/node_modules"));
  assert.ok(args.includes("PYTHONPATH=/deps"));
  assert.ok(args.includes("PYTHONNOUSERSITE=1"));
  assert.equal(args.some((value) => value.includes("API_KEY")), false);
});

test("buildSkillRunnerDockerArgs requires an immutable image digest and safe entrypoint path", () => {
  const base = {
    image: "node:22",
    runtime: "node" as const,
    artifactDir: "/cache",
    workspaceDir: "/workspace",
    outputDir: "/output",
    entrypointPath: "scripts/run.mjs",
    argv: [] as string[],
  };
  assert.throws(() => buildSkillRunnerDockerArgs(base), /immutable digest/);
  assert.throws(
    () => buildSkillRunnerDockerArgs({ ...base, image: `node@sha256:${"a".repeat(64)}`, entrypointPath: "../escape.sh" }),
    /entrypoint path/,
  );
});

test("buildSkillRunnerDockerArgs defaults to --network none and honors an explicit egress networkArgs", () => {
  const base = {
    image: `node@sha256:${"a".repeat(64)}`,
    runtime: "node" as const,
    artifactDir: "/cache",
    workspaceDir: "/workspace",
    outputDir: "/output",
    entrypointPath: "scripts/run.mjs",
    argv: [] as string[],
  };
  const isolated = buildSkillRunnerDockerArgs(base);
  const noneIndex = isolated.indexOf("--network");
  assert.equal(noneIndex !== -1 && isolated[noneIndex + 1], "none");

  const egress = buildSkillRunnerDockerArgs({
    ...base,
    networkArgs: ["--network", "dofe-runtime-restricted", "--dns", "192.0.2.1", "--add-host", "api.example.com=10.0.0.1"],
  });
  assert.equal(egress[egress.indexOf("--network") + 1], "dofe-runtime-restricted");
  assert.equal(egress[egress.indexOf("--dns") + 1], "192.0.2.1");
  assert.ok(egress.includes("api.example.com=10.0.0.1"));
  assert.equal(egress.some((value) => value === "none"), false, "an egress grant must not also carry --network none");
});

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
        ? [{ family: "ipv4", address: "10.0.0.1" }]
        : [{ family: "ipv4", address: "10.0.0.2" }],
  });
  assert.deepEqual(args, [
    "--network", "dofe-runtime-restricted", "--dns", "192.0.2.1",
    "--add-host", "api.example.com=10.0.0.1",
    "--add-host", "registry.example.com=10.0.0.2",
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

test("buildSkillRunnerSystemProbeDockerArgs probes a catalog binary hermetically with a fixed argv", () => {
  const image = `bash@sha256:${"a".repeat(64)}`;
  const args = buildSkillRunnerSystemProbeDockerArgs({ image, binary: "dot" });
  assert.ok(args.includes("--network"), "probe must be networkless");
  assert.equal(args[args.indexOf("--network") + 1], "none");
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-drop"));
  // The binary is a positional arg to a fixed `command -v "$1"` script — it
  // never enters the script string, so there is no interpolation to inject.
  assert.ok(args.includes("sh"));
  assert.ok(args.includes('command -v "$1" >/dev/null 2>&1 || exit 1'));
  assert.ok(args.includes("dot"));
  assert.ok(!args.some((arg) => arg.includes("command -v dot")));
});

test("buildSkillRunnerSystemProbeDockerArgs rejects non-digest images and unsafe binary names", () => {
  assert.throws(
    () => buildSkillRunnerSystemProbeDockerArgs({ image: "bash:latest", binary: "dot" }),
    /immutable digest/,
  );
  assert.throws(
    () => buildSkillRunnerSystemProbeDockerArgs({ image: `bash@sha256:${"a".repeat(64)}`, binary: "dot; rm -rf /" }),
    /unsafe/,
  );
});

test("startSkillRunnerBroker exposes a task-scoped launcher and removes it on close", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-state-"));
  const workDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-task-"));
  const artifactDigest = "b".repeat(64);
  const scriptBytes = Buffer.from("console.log('rendered');\n", "utf8");
  const artifactDir = getDaemonSkillInstallCachePath(stateDir, {
    workspaceId: "workspace-1",
    artifactDigest,
  });
  mkdirSync(join(artifactDir, "scripts"), { recursive: true });
  writeFileSync(join(artifactDir, "scripts", "render.mjs"), scriptBytes, { mode: 0o555 });
  writeFileSync(join(artifactDir, ".cache-complete"), "ready", { mode: 0o444 });
  chmodSync(join(artifactDir, "scripts"), 0o555);
  chmodSync(artifactDir, 0o555);
  const calls: string[][] = [];
  let mountedConfigFile = "";
  const skillEnv: Record<string, string> = {
    RENDER_TOKEN: "task-secret",
    UNRELATED_SECRET: "must-not-mount",
  };
  const runnerEnvironment = {
    ...process.env,
    DOFE_SKILL_RUNNER_NODE_IMAGE: `registry.example.com/runner@sha256:${"a".repeat(64)}`,
  };
  const broker = await startSkillRunnerBroker({
    stateDir,
    workspaceId: "workspace-1",
    workDir,
    entrypoints: [{
      key: "skill-1:render",
      skillId: "skill-1",
      skillName: "Renderer",
      installationId: "installation-1",
      artifactDigest,
      sha256: createHash("sha256").update(scriptBytes).digest("hex"),
      id: "render",
      path: "scripts/render.mjs",
      runtime: "node",
      configKeys: ["RENDER_TOKEN"],
    }],
    skillEnv,
    environment: runnerEnvironment,
    inspectImage: () => true,
    execute: async (args) => {
      calls.push(args);
      const outputMount = args.find((value) => value.endsWith(",dst=/output"));
      assert.ok(outputMount);
      const outputDir = outputMount.slice("type=bind,src=".length, -",dst=/output".length);
      assert.equal(statSync(outputDir).mode & 0o777, 0o777);
      writeFileSync(join(outputDir, "result.txt"), "published", "utf8");
      const configMount = args.find((value) => value.endsWith(",dst=/run/secrets/dofe-skill-config.json,readonly"));
      assert.ok(configMount);
      mountedConfigFile = configMount.slice(
        "type=bind,src=".length,
        -",dst=/run/secrets/dofe-skill-config.json,readonly".length,
      );
      assert.deepEqual(JSON.parse(readFileSync(mountedConfigFile, "utf8")), { RENDER_TOKEN: "task-secret" });
      assert.equal(args.some((value) => value.includes("task-secret") || value.includes("must-not-mount")), false);
      return { exitCode: 0, stdout: "rendered\n", stderr: "", timedOut: false };
    },
  });
  try {
    runnerEnvironment.DOFE_SKILL_RUNNER_NODE_IMAGE = `registry.example.com/runner@sha256:${"d".repeat(64)}`;
    assert.equal(broker.capabilities[0]?.status, "available");
    const launcher = broker.capabilities[0]?.binPath;
    assert.ok(launcher && existsSync(launcher));
    const result = await execFileAsync(launcher, ["--title", "quarterly"]);
    assert.equal(result.stdout, "rendered\n");
    assert.deepEqual(calls[0]?.slice(-4), ["node", "/skill/scripts/render.mjs", "--title", "quarterly"]);
    assert.ok(calls[0]?.includes(`registry.example.com/runner@sha256:${"a".repeat(64)}`));
    assert.equal(calls[0]?.includes(`registry.example.com/runner@sha256:${"d".repeat(64)}`), false);
    assert.equal(existsSync(mountedConfigFile), false);
    delete skillEnv.RENDER_TOKEN;
    await assert.rejects(execFileAsync(launcher), /skill_runner\.config_missing: RENDER_TOKEN/);
    assert.equal(calls.length, 1);
    assert.equal(readFileSync(join(workDir, "runtime-output", "skill-runs", "skill-1-render", "result.txt"), "utf8"), "published");
    await broker.close();
    assert.equal(existsSync(launcher), false);
  } finally {
    await broker.close().catch(() => {});
    chmodSync(artifactDir, 0o755);
    chmodSync(join(artifactDir, "scripts"), 0o755);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("startSkillRunnerBroker keeps output publication inside the launcher namespace", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-state-"));
  const workDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-task-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-outside-"));
  const artifactDigest = "c".repeat(64);
  const scriptBytes = Buffer.from("console.log('rendered');\n", "utf8");
  const artifactDir = getDaemonSkillInstallCachePath(stateDir, {
    workspaceId: "workspace-1",
    artifactDigest,
  });
  mkdirSync(join(artifactDir, "scripts"), { recursive: true });
  writeFileSync(join(artifactDir, "scripts", "render.mjs"), scriptBytes, { mode: 0o555 });
  writeFileSync(join(artifactDir, ".cache-complete"), "ready", { mode: 0o444 });
  chmodSync(join(artifactDir, "scripts"), 0o555);
  chmodSync(artifactDir, 0o555);
  const outputRoot = join(workDir, "runtime-output", "skill-runs");
  mkdirSync(outputRoot, { recursive: true });
  symlinkSync(outsideDir, join(outputRoot, "skill-1-render"), "dir");
  let executeCalls = 0;
  const broker = await startSkillRunnerBroker({
    stateDir,
    workspaceId: "workspace-1",
    workDir,
    entrypoints: [{
      key: "skill-1:render",
      skillId: "skill-1",
      skillName: "Renderer",
      installationId: "installation-1",
      artifactDigest,
      sha256: createHash("sha256").update(scriptBytes).digest("hex"),
      id: "render",
      path: "scripts/render.mjs",
      runtime: "node",
    }],
    environment: {
      ...process.env,
      DOFE_SKILL_RUNNER_NODE_IMAGE: `registry.example.com/runner@sha256:${"a".repeat(64)}`,
    },
    inspectImage: () => true,
    execute: async () => {
      executeCalls += 1;
      return { exitCode: 0, stdout: "rendered\n", stderr: "", timedOut: false };
    },
  });
  try {
    const launcher = broker.capabilities[0]?.binPath;
    assert.ok(launcher);
    await assert.rejects(execFileAsync(launcher), /symlink/i);
    assert.equal(executeCalls, 1);
    assert.equal(existsSync(join(outsideDir, "result.txt")), false);
  } finally {
    await broker.close().catch(() => {});
    chmodSync(artifactDir, 0o755);
    chmodSync(join(artifactDir, "scripts"), 0o755);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("startSkillRunnerBroker rejects Runner output symlinks before publication", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-state-"));
  const workDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-task-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-outside-"));
  const artifactDigest = "d".repeat(64);
  const scriptBytes = Buffer.from("console.log('rendered');\n", "utf8");
  const artifactDir = getDaemonSkillInstallCachePath(stateDir, {
    workspaceId: "workspace-1",
    artifactDigest,
  });
  mkdirSync(join(artifactDir, "scripts"), { recursive: true });
  writeFileSync(join(artifactDir, "scripts", "render.mjs"), scriptBytes, { mode: 0o555 });
  writeFileSync(join(artifactDir, ".cache-complete"), "ready", { mode: 0o444 });
  chmodSync(join(artifactDir, "scripts"), 0o555);
  chmodSync(artifactDir, 0o555);
  writeFileSync(join(outsideDir, "secret.txt"), "must-not-publish", "utf8");
  const broker = await startSkillRunnerBroker({
    stateDir,
    workspaceId: "workspace-1",
    workDir,
    entrypoints: [{
      key: "skill-output-link:render",
      skillId: "skill-output-link",
      skillName: "Output Link Renderer",
      installationId: "installation-output-link",
      artifactDigest,
      sha256: createHash("sha256").update(scriptBytes).digest("hex"),
      id: "render",
      path: "scripts/render.mjs",
      runtime: "node",
    }],
    environment: {
      ...process.env,
      DOFE_SKILL_RUNNER_NODE_IMAGE: `registry.example.com/runner@sha256:${"a".repeat(64)}`,
    },
    inspectImage: () => true,
    execute: async (args) => {
      const outputMount = args.find((value) => value.endsWith(",dst=/output"));
      assert.ok(outputMount);
      const outputDir = outputMount.slice("type=bind,src=".length, -",dst=/output".length);
      symlinkSync(join(outsideDir, "secret.txt"), join(outputDir, "leak.txt"));
      return { exitCode: 0, stdout: "rendered\n", stderr: "", timedOut: false };
    },
  });
  try {
    const launcher = broker.capabilities[0]?.binPath;
    assert.ok(launcher);
    await assert.rejects(execFileAsync(launcher), /skill_runner\.output_symlink_forbidden/);
    assert.equal(existsSync(join(workDir, "runtime-output", "skill-runs", "skill-output-link-render", "leak.txt")), false);
  } finally {
    await broker.close().catch(() => {});
    chmodSync(artifactDir, 0o755);
    chmodSync(join(artifactDir, "scripts"), 0o755);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("startSkillRunnerBroker rejects duplicate task-scoped entrypoint keys", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-state-"));
  const workDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-task-"));
  const entrypoint = {
    key: "skill-1:render",
    skillId: "skill-1",
    skillName: "Renderer",
    installationId: "installation-1",
    artifactDigest: "e".repeat(64),
    sha256: "f".repeat(64),
    id: "render",
    path: "scripts/render.mjs",
    runtime: "node" as const,
  };
  try {
    await assert.rejects(
      startSkillRunnerBroker({
        stateDir,
        workspaceId: "workspace-1",
        workDir,
        entrypoints: [entrypoint, { ...entrypoint }],
        inspectImage: () => true,
      }),
      /duplicate_entrypoint_key/,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("startSkillRunnerBroker rejects calls above the configured concurrency limit", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-state-"));
  const workDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-task-"));
  const artifactDigest = "f".repeat(64);
  const scriptBytes = Buffer.from("console.log('rendered');\n", "utf8");
  const artifactDir = getDaemonSkillInstallCachePath(stateDir, {
    workspaceId: "workspace-1",
    artifactDigest,
  });
  mkdirSync(join(artifactDir, "scripts"), { recursive: true });
  writeFileSync(join(artifactDir, "scripts", "render.mjs"), scriptBytes, { mode: 0o555 });
  writeFileSync(join(artifactDir, ".cache-complete"), "ready", { mode: 0o444 });
  chmodSync(join(artifactDir, "scripts"), 0o555);
  chmodSync(artifactDir, 0o555);
  let releaseExecution: (() => void) | undefined;
  const executionGate = new Promise<void>((resolve) => { releaseExecution = resolve; });
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let executeCalls = 0;
  const broker = await startSkillRunnerBroker({
    stateDir,
    workspaceId: "workspace-1",
    workDir,
    entrypoints: [{
      key: "skill-limited:render",
      skillId: "skill-limited",
      skillName: "Limited Renderer",
      installationId: "installation-limited",
      artifactDigest,
      sha256: createHash("sha256").update(scriptBytes).digest("hex"),
      id: "render",
      path: "scripts/render.mjs",
      runtime: "node",
    }],
    environment: {
      ...process.env,
      DOFE_SKILL_RUNNER_NODE_IMAGE: `registry.example.com/runner@sha256:${"a".repeat(64)}`,
      DOFE_SKILL_RUNNER_MAX_CONCURRENCY: "1",
    },
    inspectImage: () => true,
    execute: async () => {
      executeCalls += 1;
      markStarted?.();
      await executionGate;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    },
  });
  try {
    const launcher = broker.capabilities[0]?.binPath;
    assert.ok(launcher);
    const first = execFileAsync(launcher);
    await started;
    await assert.rejects(execFileAsync(launcher));
    assert.equal(executeCalls, 1);
    releaseExecution?.();
    await first;
  } finally {
    releaseExecution?.();
    await broker.close().catch(() => {});
    chmodSync(artifactDir, 0o755);
    chmodSync(join(artifactDir, "scripts"), 0o755);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("startSkillRunnerBroker force-removes a timed-out Docker container before deleting config", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-state-"));
  const workDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-task-"));
  const fakeDockerDir = mkdtempSync(join(tmpdir(), "dofe-skill-runner-docker-"));
  const fakeDocker = join(fakeDockerDir, "docker");
  const dockerLog = join(fakeDockerDir, "calls.log");
  const artifactDigest = "e".repeat(64);
  const scriptBytes = Buffer.from("console.log('rendered');\n", "utf8");
  const artifactDir = getDaemonSkillInstallCachePath(stateDir, {
    workspaceId: "workspace-1",
    artifactDigest,
  });
  mkdirSync(join(artifactDir, "scripts"), { recursive: true });
  writeFileSync(join(artifactDir, "scripts", "render.mjs"), scriptBytes, { mode: 0o555 });
  writeFileSync(join(artifactDir, ".cache-complete"), "ready", { mode: 0o444 });
  chmodSync(join(artifactDir, "scripts"), 0o555);
  chmodSync(artifactDir, 0o555);
  writeFileSync(fakeDocker, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(dockerLog)}\nif [ "$1" = "run" ]; then\n  while :; do :; done\nfi\nexit 0\n`, { mode: 0o700 });

  const broker = await startSkillRunnerBroker({
    stateDir,
    workspaceId: "workspace-1",
    workDir,
    entrypoints: [{
      key: "skill-timeout:render",
      skillId: "skill-timeout",
      skillName: "Timeout Renderer",
      installationId: "installation-timeout",
      artifactDigest,
      sha256: createHash("sha256").update(scriptBytes).digest("hex"),
      id: "render",
      path: "scripts/render.mjs",
      runtime: "node",
      configKeys: ["RENDER_TOKEN"],
    }],
    skillEnv: { RENDER_TOKEN: "short-lived" },
    environment: {
      ...process.env,
      DOFE_SKILL_RUNNER_DOCKER_BIN: fakeDocker,
      DOFE_SKILL_RUNNER_NODE_IMAGE: `registry.example.com/runner@sha256:${"a".repeat(64)}`,
      DOFE_SKILL_RUNNER_TIMEOUT_MS: "1000",
    },
    inspectImage: () => true,
  });
  try {
    const launcher = broker.capabilities[0]?.binPath;
    assert.ok(launcher);
    await assert.rejects(execFileAsync(launcher));
    const calls = readFileSync(dockerLog, "utf8").trim().split("\n");
    const runCall = calls.find((call) => call.startsWith("run "));
    assert.ok(runCall, JSON.stringify(calls));
    const containerName = /(?:^| )--name ([^ ]+)/.exec(runCall)?.[1];
    assert.ok(containerName);
    assert.ok(calls.includes(`rm -f ${containerName}`));
    const configFile = /src=([^,]+),dst=\/run\/secrets\/dofe-skill-config\.json,readonly/.exec(runCall)?.[1];
    assert.ok(configFile);
    assert.equal(existsSync(configFile), false);
  } finally {
    await broker.close().catch(() => {});
    chmodSync(artifactDir, 0o755);
    chmodSync(join(artifactDir, "scripts"), 0o755);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
    rmSync(fakeDockerDir, { recursive: true, force: true });
  }
});
