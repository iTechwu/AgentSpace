import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import {
  buildCosignVerificationArgs,
  buildEgressHostsFile,
  buildManagedServiceContainerCreateArgs,
  buildManagedServiceContainerName,
  buildManagedServiceHealthcheckArgs,
  buildManagedServiceInspectArgs,
  buildManagedServiceInternalNetworkName,
  buildManagedServiceSecretDir,
  buildManagedServiceNetworkArgs,
  buildManagedServiceResourceArgs,
  computeManagedServiceHealthRevision,
  createDockerManagedServiceContainerRuntime as createProductionManagedServiceContainerRuntime,
  DockerContainerError,
  parseEgressAllowlistHostnames,
  verifyManagedServiceImageSignatureSync,
  writeManagedServiceSecretFiles,
  type ManagedContainerExec,
} from "./managed-service-runtime.ts";
import type { ManagedServiceEgressPolicyRuntime } from "./egress-policy.ts";

const NETWORK = "dofe-internal";

beforeEach(() => {
  process.env.MANAGED_RUNTIME_DOCKER_NETWORK = NETWORK;
  delete process.env.MANAGED_RUNTIME_DOCKER_EXTRA_HOSTS;
});

afterEach(() => {
  delete process.env.MANAGED_RUNTIME_DOCKER_NETWORK;
});

function fakeExec(
  handler: (args: string[]) => { stdout?: string; stderr?: string; exitCode?: number },
): { exec: ManagedContainerExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ManagedContainerExec = async (args) => {
    calls.push(args);
    const response = handler(args);
    return { stdout: response.stdout ?? "", stderr: response.stderr ?? "", exitCode: response.exitCode ?? 0 };
  };
  return { exec, calls };
}

function fakeEgressPolicy(): {
  runtime: ManagedServiceEgressPolicyRuntime;
  applied: Parameters<ManagedServiceEgressPolicyRuntime["apply"]>[0][];
  removed: string[];
} {
  const applied: Parameters<ManagedServiceEgressPolicyRuntime["apply"]>[0][] = [];
  const removed: string[] = [];
  return {
    applied,
    removed,
    runtime: {
      apply: async (input) => { applied.push(input); },
      remove: async ({ serviceId }) => { removed.push(serviceId); },
    },
  };
}

function createDockerManagedServiceContainerRuntime(
  exec?: ManagedContainerExec,
  options?: Parameters<typeof createProductionManagedServiceContainerRuntime>[1],
) {
  return createProductionManagedServiceContainerRuntime(exec, {
    egressPolicyRuntime: fakeEgressPolicy().runtime,
    ...options,
  });
}

const provisionInput = {
  serviceId: "svc-1",
  workspaceId: "default",
  imageDigest: "sha256:abc",
  networkJson: JSON.stringify({ egressAllowlist: [] }),
};

/* ------------------------------------------------------------------ */
/* Pure command builders                                               */
/* ------------------------------------------------------------------ */

test("buildManagedServiceContainerName is deterministic and sanitized", () => {
  assert.equal(buildManagedServiceContainerName("svc-1"), "dofe-svc-svc-1");
  assert.equal(buildManagedServiceContainerName("svc 1/x"), "dofe-svc-svc-1-x");
});

test("buildManagedServiceResourceArgs maps memory/cpu/memorySwap and ignores bad JSON", () => {
  assert.deepEqual(
    buildManagedServiceResourceArgs(JSON.stringify({ memory: "128Mi", cpu: "250m", memorySwap: "256Mi" })),
    ["--memory", "128Mi", "--cpus", "250m", "--memory-swap", "256Mi"],
  );
  assert.deepEqual(buildManagedServiceResourceArgs("not json"), []);
  assert.deepEqual(buildManagedServiceResourceArgs(undefined), []);
});

test("buildManagedServiceHealthcheckArgs builds explicit cmd or path-derived probe", () => {
  const explicit = buildManagedServiceHealthcheckArgs(JSON.stringify({ cmd: "curl -f localhost:9000/healthz" }));
  assert.equal(explicit[0], "--health-cmd");
  assert.equal(explicit[1], "curl -f localhost:9000/healthz");

  const pathArgs = buildManagedServiceHealthcheckArgs(JSON.stringify({ path: "/healthz", port: 9000 }));
  assert.ok((pathArgs[1] as string).includes("127.0.0.1:9000/healthz"));

  assert.deepEqual(buildManagedServiceHealthcheckArgs(undefined), []);
  assert.deepEqual(buildManagedServiceHealthcheckArgs("not json"), []);
  assert.deepEqual(buildManagedServiceHealthcheckArgs("{}"), []);
});

test("buildManagedServiceContainerCreateArgs pins digest, isolated network, labels, hardening", () => {
  const args = buildManagedServiceContainerCreateArgs({
    containerName: "dofe-svc-svc-1",
    serviceId: "svc-1",
    workspaceId: "default",
    imageDigest: "sha256:abc",
    network: NETWORK,
    resourcesJson: JSON.stringify({ memory: "128Mi" }),
    healthJson: JSON.stringify({ path: "/healthz" }),
  });

  assert.equal(args[0], "create");
  assert.equal(args[args.indexOf("--name") + 1], "dofe-svc-svc-1");
  assert.equal(args[args.indexOf("--network") + 1], NETWORK);
  assert.equal(args[args.indexOf("--label") + 1], "dofe.agent.serviceId=svc-1");
  assert.ok(args.includes("--read-only"));
  assert.deepEqual(args.slice(args.indexOf("--restart"), args.indexOf("--restart") + 2), ["--restart", "no"]);
  assert.ok(args.includes("--cap-drop"));
  assert.ok(args.includes("--security-opt"));
  assert.ok(args.includes("--memory"), "resource args wired in");
  assert.ok(args.includes("--health-cmd"), "healthcheck args wired in");
  assert.equal(args[args.length - 1], "sha256:abc", "image digest is the final pinned arg");
});

test("create args honor the catalog hardening profile", () => {
  const base = {
    containerName: "dofe-svc-svc-1",
    serviceId: "svc-1",
    workspaceId: "default",
    imageDigest: "sha256:abc",
    network: NETWORK,
  };

  // Default: read-only rootfs + drop ALL + no explicit user.
  const defaults = buildManagedServiceContainerCreateArgs(base);
  assert.ok(defaults.includes("--read-only"));
  assert.equal(defaults[defaults.indexOf("--cap-drop") + 1], "ALL");
  assert.ok(!defaults.includes("--user"));

  // runAsNonRoot → explicit non-root user.
  const nonRoot = buildManagedServiceContainerCreateArgs({ ...base, runAsNonRoot: true });
  assert.equal(nonRoot[nonRoot.indexOf("--user") + 1], "65532:65532");

  // readOnlyRootfs: false → no --read-only.
  const writable = buildManagedServiceContainerCreateArgs({ ...base, readOnlyRootfs: false });
  assert.ok(!writable.includes("--read-only"));

  // capDrop list → one --cap-drop per capability.
  const capDrop = buildManagedServiceContainerCreateArgs({ ...base, capDrop: ["NET_ADMIN", "SYS_TIME"] });
  assert.deepEqual(
    capDrop.filter((arg) => arg === "--cap-drop").length,
    2,
  );
  assert.ok(capDrop.includes("NET_ADMIN"));
  assert.ok(capDrop.includes("SYS_TIME"));
});

test("create args mount declared secrets as read-only files without plaintext argv", () => {
  const args = buildManagedServiceContainerCreateArgs({
    containerName: "dofe-svc-svc-1",
    serviceId: "svc-1",
    workspaceId: "default",
    imageDigest: "sha256:abc",
    network: NETWORK,
    secretMounts: [
      { name: "RENDER_LICENSE", hostPath: "/state/generation-1/RENDER_LICENSE" },
      { name: "API_KEY", hostPath: "/state/generation-1/API_KEY" },
    ],
  });

  const envIndex = args.indexOf("--env");
  assert.ok(envIndex >= 0);
  assert.equal(args[envIndex + 1], "RENDER_LICENSE_FILE=/run/secrets/RENDER_LICENSE");
  assert.ok(args.includes("API_KEY_FILE=/run/secrets/API_KEY"));
  assert.ok(args.some((arg) => arg.includes("dst=/run/secrets/RENDER_LICENSE,readonly")));
  assert.ok(!args.some((arg) => arg.includes("sk-secret") || arg.includes("ak-123")));

  // No secrets → no --env flags.
  const noSecrets = buildManagedServiceContainerCreateArgs({
    containerName: "dofe-svc-svc-1",
    serviceId: "svc-1",
    workspaceId: "default",
    imageDigest: "sha256:abc",
    network: NETWORK,
  });
  assert.ok(!noSecrets.includes("--env"));
});

test("secret files are generation-scoped with restrictive permissions", async () => {
  const rootDir = await fs.mkdtemp(join(tmpdir(), "dofe-secret-test-"));
  try {
    const result = await writeManagedServiceSecretFiles({
      rootDir,
      serviceId: "svc/one",
      secrets: { API_KEY: "secret-value" },
    });
    assert.equal(result.serviceDir, buildManagedServiceSecretDir(rootDir, "svc/one"));
    assert.ok(result.generationDir?.startsWith(result.serviceDir));
    assert.equal(await fs.readFile(result.mounts[0]!.hostPath, "utf8"), "secret-value");
    assert.equal((await fs.stat(rootDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(result.serviceDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(result.mounts[0]!.hostPath)).mode & 0o777, 0o400);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("non-root secret files are owned by the declared container uid without relaxing mode", async () => {
  const rootDir = await fs.mkdtemp(join(tmpdir(), "dofe-secret-owner-"));
  const ownership: Array<{ path: string; uid: number; gid: number }> = [];
  try {
    const result = await writeManagedServiceSecretFiles({
      rootDir,
      serviceId: "svc-owner",
      secrets: { API_KEY: "secret" },
      owner: { uid: 65_532, gid: 65_532 },
      chown: async (path, uid, gid) => { ownership.push({ path, uid, gid }); },
    });
    assert.deepEqual(ownership, [{ path: result.mounts[0]!.hostPath, uid: 65_532, gid: 65_532 }]);
    assert.equal((await fs.stat(result.mounts[0]!.hostPath)).mode & 0o777, 0o400);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("secret writer rejects traversal and shell-style field names", async () => {
  const rootDir = await fs.mkdtemp(join(tmpdir(), "dofe-secret-test-"));
  try {
    await assert.rejects(
      writeManagedServiceSecretFiles({ rootDir, serviceId: "svc-1", secrets: { "../TOKEN": "secret" } }),
      (error: unknown) => error instanceof DockerContainerError && error.code === "skill_service.secret_name_invalid",
    );
    assert.deepEqual(await fs.readdir(rootDir), []);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Egress enforcement (pure builders + provision)                      */
/* ------------------------------------------------------------------ */

test("parseEgressAllowlistHostnames strips schemes, paths and ports", () => {
  assert.deepEqual(
    parseEgressAllowlistHostnames(["https://fonts.example.com/a.css", "api.example.com:443", "raw.example.com"]),
    ["fonts.example.com", "api.example.com", "raw.example.com"],
  );
  assert.deepEqual(parseEgressAllowlistHostnames([]), []);
});

test("buildEgressHostsFile pins resolved IPs and localhost", () => {
  const ipByHostname = new Map([["fonts.example.com", ["203.0.113.10", "2001:db8::10"]]]);
  const content = buildEgressHostsFile(["fonts.example.com"], ipByHostname);
  assert.match(content, /127\.0\.0\.1 localhost/);
  assert.match(content, /203\.0\.113\.10 fonts\.example\.com/);
  assert.match(content, /2001:db8::10 fonts\.example\.com/);
});

test("buildManagedServiceNetworkArgs: policy keeps private ingress; non-empty also pins DNS", () => {
  const shared = buildManagedServiceNetworkArgs({ egressAllowlist: undefined, network: "mgmt", workspaceId: "default" });
  assert.deepEqual(shared.args, ["--network", "mgmt"]);
  assert.equal(shared.internalNetworkName, undefined);

  const internal = buildManagedServiceNetworkArgs({ egressAllowlist: [], network: "mgmt", workspaceId: "default" });
  assert.equal(buildManagedServiceInternalNetworkName("default"), "dofe-svc-internal-default");
  assert.deepEqual(internal.args, ["--network", "mgmt"]);
  assert.equal(internal.internalNetworkName, undefined);

  const allow = buildManagedServiceNetworkArgs({
    egressAllowlist: ["fonts.example.com:443"],
    network: "mgmt",
    workspaceId: "default",
    egressHostEntries: [{ hostname: "fonts.example.com", address: "203.0.113.10" }],
  });
  assert.ok(allow.args.includes("--dns"));
  assert.ok(allow.args.includes("fonts.example.com=203.0.113.10"), "resolved address must be pinned");
});

test("provision with an empty allow-list applies a drop-only policy before start", async () => {
  const { exec, calls } = fakeExec((args) => {
    switch (args[0]) {
      case "pull": return {};
      case "create": return { stdout: "cid\n" };
      case "start": return {};
      case "inspect": return { stdout: args.includes("{{json .NetworkSettings.Networks}}")
        ? JSON.stringify({ mgmt: { IPAddress: "172.18.0.4", GlobalIPv6Address: "" } })
        : "true\n" };
      default: return { stderr: `unexpected ${args.join(" ")}`, exitCode: 1 };
    }
  });
  const policy = fakeEgressPolicy();
  const runtime = createDockerManagedServiceContainerRuntime(exec, { egressPolicyRuntime: policy.runtime });

  const result = await runtime.provision({
    ...provisionInput,
    networkJson: JSON.stringify({ egressAllowlist: [] }),
  });

  assert.equal(result.endpointRef, "runtime-private://dofe-svc-svc-1");
  const createCall = calls.find((args) => args[0] === "create")!;
  assert.equal(createCall.filter((arg) => arg === "--network").length, 1);
  assert.equal(policy.applied.length, 1);
  assert.deepEqual(policy.applied[0]!.targets, []);
  assert.deepEqual(policy.applied[0]!.sourceAddresses, [{ family: "ipv4", address: "172.18.0.4" }]);
  assert.ok(calls.findIndex((args) => args[0] === "inspect") < calls.findIndex((args) => args[0] === "start"));
});

test("provision with a non-empty allow-list pins hosts and blocks DNS", async () => {
  const { exec, calls } = fakeExec((args) => {
    if (args[0] === "inspect") return { stdout: args.includes("{{json .NetworkSettings.Networks}}")
      ? JSON.stringify({ mgmt: { IPAddress: "172.18.0.4", GlobalIPv6Address: "fd00::4" } })
      : "true\n" };
    if (args[0] === "create") return { stdout: "cid\n" };
    return {};
  });
  const policy = fakeEgressPolicy();
  const runtime = createDockerManagedServiceContainerRuntime(exec, {
    lookupHost: async () => [
      { family: "ipv4", address: "203.0.113.10" },
      { family: "ipv6", address: "2001:db8::10" },
    ],
    egressPolicyRuntime: policy.runtime,
  });

  const result = await runtime.provision({
    ...provisionInput,
    networkJson: JSON.stringify({ egressAllowlist: ["fonts.example.com:443"] }),
  });

  assert.equal(result.endpointRef, "runtime-private://dofe-svc-svc-1");
  const createCall = calls.find((args) => args[0] === "create")!;
  assert.ok(createCall.includes("--dns"), "dead DNS blocks unknown hostnames");
  assert.ok(createCall.includes("fonts.example.com=203.0.113.10"));
  assert.ok(createCall.includes("fonts.example.com=2001:db8::10"));
  assert.ok(!createCall.includes("dofe-svc-internal"), "non-empty allow-list stays on the shared network");
  assert.deepEqual(policy.applied[0]!.targets, [{
    hostname: "fonts.example.com",
    port: 443,
    addresses: [
      { family: "ipv4", address: "203.0.113.10" },
      { family: "ipv6", address: "2001:db8::10" },
    ],
  }]);
});

test("provision does not start the container when L3/L4 policy cannot be applied", async () => {
  const { exec, calls } = fakeExec((args) => {
    if (args[0] === "create") return { stdout: "cid\n" };
    if (args[0] === "inspect") {
      return { stdout: JSON.stringify({ mgmt: { IPAddress: "172.18.0.4" } }) };
    }
    return {};
  });
  const runtime = createDockerManagedServiceContainerRuntime(exec, {
    egressPolicyRuntime: {
      apply: async () => { throw new Error("permission denied"); },
      remove: async () => {},
    },
  });

  await assert.rejects(
    runtime.provision({ ...provisionInput, networkJson: JSON.stringify({ egressAllowlist: [] }) }),
    (error: unknown) => error instanceof DockerContainerError
      && error.code === "skill_service.egress_policy_error",
  );
  assert.equal(calls.some((args) => args[0] === "start"), false);
  assert.ok(calls.some((args) => args[0] === "rm" && args.includes("-f")));
});

test("provision rejects missing or malformed egress policy before creating a container", async () => {
  const { exec, calls } = fakeExec(() => ({}));
  const runtime = createDockerManagedServiceContainerRuntime(exec);
  await assert.rejects(
    runtime.provision({ serviceId: "missing-policy", workspaceId: "default", imageDigest: "sha256:abc" }),
    (error: unknown) => error instanceof DockerContainerError && error.code === "skill_service.egress_policy_missing",
  );
  await assert.rejects(
    runtime.provision({
      serviceId: "bad-policy",
      workspaceId: "default",
      imageDigest: "sha256:abc",
      networkJson: "not-json",
    }),
    (error: unknown) => error instanceof DockerContainerError && error.code === "skill_service.egress_policy_invalid",
  );
  assert.equal(calls.some((args) => args[0] === "create"), false);
});

test("computeManagedServiceHealthRevision is deterministic per config + state", () => {
  assert.equal(computeManagedServiceHealthRevision("{}", "healthy"), computeManagedServiceHealthRevision("{}", "healthy"));
  assert.notEqual(computeManagedServiceHealthRevision("{}", "healthy"), computeManagedServiceHealthRevision("{}", "starting"));
  assert.equal(computeManagedServiceHealthRevision(undefined, "true"), computeManagedServiceHealthRevision(undefined, "true"));
});

/* ------------------------------------------------------------------ */
/* Runtime (docker lifecycle via fake exec)                            */
/* ------------------------------------------------------------------ */

test("provision runs pull → create → start → inspect and returns the endpoint", async () => {
  const { exec, calls } = fakeExec((args) => {
    switch (args[0]) {
      case "pull": return {};
      case "create": return { stdout: "abc123\n" };
      case "start": return {};
      case "inspect": return { stdout: args.includes("{{json .NetworkSettings.Networks}}")
        ? JSON.stringify({ mgmt: { IPAddress: "172.18.0.4" } })
        : "true\n" };
      default: return { stderr: `unexpected ${args.join(" ")}`, exitCode: 1 };
    }
  });
  const runtime = createDockerManagedServiceContainerRuntime(exec);

  const result = await runtime.provision(provisionInput);

  assert.equal(result.endpointRef, "runtime-private://dofe-svc-svc-1");
  assert.equal(result.containerName, "dofe-svc-svc-1");
  assert.ok(result.healthRevision.length > 0);
  assert.deepEqual(calls.map((args) => args[0]), ["pull", "create", "inspect", "start", "inspect"]);
  const inspect = calls[4]!;
  assert.equal(inspect[inspect.indexOf("--format") + 1], "{{.State.Running}}", "no healthcheck → wait for running");
});

test("provision keeps only the active secret generation and never passes plaintext to docker", async () => {
  const secretRootDir = await fs.mkdtemp(join(tmpdir(), "dofe-secret-runtime-"));
  const serviceDir = buildManagedServiceSecretDir(secretRootDir, provisionInput.serviceId);
  await fs.mkdir(join(serviceDir, "generation-stale"), { recursive: true });
  try {
    const { exec, calls } = fakeExec((args) => {
      if (args[0] === "create") return { stdout: "cid\n" };
      if (args[0] === "inspect") return { stdout: "true\n" };
      return {};
    });
    const runtime = createDockerManagedServiceContainerRuntime(exec, { secretRootDir });

    await runtime.provision({ ...provisionInput, secrets: { API_KEY: "runtime-secret" } });

    const createCall = calls.find((args) => args[0] === "create")!;
    assert.ok(!createCall.some((arg) => arg.includes("runtime-secret")));
    const generations = await fs.readdir(serviceDir);
    assert.equal(generations.length, 1);
    assert.ok(generations[0]!.startsWith("generation-"));
    assert.notEqual(generations[0], "generation-stale");
  } finally {
    await fs.rm(secretRootDir, { recursive: true, force: true });
  }
});

test("successful provision without secrets clears stale secret generations", async () => {
  const secretRootDir = await fs.mkdtemp(join(tmpdir(), "dofe-secret-runtime-"));
  const serviceDir = buildManagedServiceSecretDir(secretRootDir, provisionInput.serviceId);
  await fs.mkdir(join(serviceDir, "generation-stale"), { recursive: true });
  try {
    const { exec } = fakeExec((args) => {
      if (args[0] === "create") return { stdout: "cid\n" };
      if (args[0] === "inspect") return { stdout: "true\n" };
      return {};
    });
    const runtime = createDockerManagedServiceContainerRuntime(exec, { secretRootDir });

    await runtime.provision(provisionInput);

    assert.deepEqual(await fs.readdir(serviceDir), []);
  } finally {
    await fs.rm(secretRootDir, { recursive: true, force: true });
  }
});

test("provision waits for the healthy state when a healthcheck is configured", async () => {
  let healthy = false;
  const { exec } = fakeExec((args) => {
    if (args[0] === "inspect") {
      if (args.includes("{{json .NetworkSettings.Networks}}")) {
        return { stdout: JSON.stringify({ mgmt: { IPAddress: "172.18.0.4" } }) };
      }
      return healthy ? { stdout: "healthy\n" } : { stdout: "starting\n" };
    }
    if (args[0] === "create") return { stdout: "abc\n" };
    return {};
  });
  const runtime = createDockerManagedServiceContainerRuntime(exec, { healthPollIntervalMs: 5, healthWaitMs: 2_000 });

  const promise = runtime.provision({ ...provisionInput, healthJson: JSON.stringify({ path: "/healthz" }) });
  setTimeout(() => {
    healthy = true;
  }, 20);
  const result = await promise;

  assert.ok(result.endpointRef.startsWith("runtime-private://"));
  assert.ok(result.healthRevision.length > 0);
});

test("provision retries create when a stale container name exists", async () => {
  let createCount = 0;
  const { exec, calls } = fakeExec((args) => {
    if (args[0] === "create") {
      createCount += 1;
      return createCount === 1
        ? { stderr: "Conflict. The container name \"/dofe-svc-svc-1\" is already in use by container", exitCode: 125 }
        : { stdout: "def\n" };
    }
    if (args[0] === "rm") return {};
    if (args[0] === "inspect") return { stdout: "true\n" };
    return {};
  });
  const runtime = createDockerManagedServiceContainerRuntime(exec);

  const result = await runtime.provision(provisionInput);

  assert.equal(result.endpointRef, "runtime-private://dofe-svc-svc-1");
  assert.equal(createCount, 2);
  assert.ok(calls.some((args) => args[0] === "rm" && args.includes("-f")));
});

test("provision fails with a health timeout when the container never becomes healthy", async () => {
  const secretRootDir = await fs.mkdtemp(join(tmpdir(), "dofe-secret-runtime-"));
  const { exec, calls } = fakeExec((args) => {
    if (args[0] === "inspect" && args.includes("{{json .NetworkSettings.Networks}}")) {
      return { stdout: JSON.stringify({ mgmt: { IPAddress: "172.18.0.4" } }) };
    }
    return args[0] === "inspect" ? { stdout: "starting\n" } : { stdout: "abc\n" };
  });
  const runtime = createDockerManagedServiceContainerRuntime(exec, {
    healthPollIntervalMs: 5,
    healthWaitMs: 30,
    secretRootDir,
  });

  try {
    await assert.rejects(
      runtime.provision({
        ...provisionInput,
        healthJson: JSON.stringify({ path: "/healthz" }),
        secrets: { API_KEY: "failed-secret" },
      }),
      (error: unknown) => error instanceof DockerContainerError && error.code === "skill_service.container_health_timeout",
    );
    assert.ok(calls.some((args) => args[0] === "rm" && args.includes("-f")), "failed container must be removed");
    const serviceDir = buildManagedServiceSecretDir(secretRootDir, provisionInput.serviceId);
    assert.deepEqual(await fs.readdir(serviceDir), [], "failed secret generation must be removed");
  } finally {
    await fs.rm(secretRootDir, { recursive: true, force: true });
  }
});

test("provision fails closed when the managed docker network env is missing", async () => {
  delete process.env.MANAGED_RUNTIME_DOCKER_NETWORK;
  const { exec } = fakeExec(() => ({}));
  const runtime = createDockerManagedServiceContainerRuntime(exec);

  await assert.rejects(
    runtime.provision(provisionInput),
    /docker_network_required/,
  );
});

test("retire removes the container and tolerates a missing container", async () => {
  const secretRootDir = await fs.mkdtemp(join(tmpdir(), "dofe-secret-runtime-"));
  const serviceDir = buildManagedServiceSecretDir(secretRootDir, "svc-1");
  await fs.mkdir(join(serviceDir, "generation-old"), { recursive: true });
  const { exec, calls } = fakeExec((args) => args[0] === "rm"
    ? { stderr: "Error response from daemon: No such container: dofe-svc-svc-1", exitCode: 1 }
    : {});
  const runtime = createDockerManagedServiceContainerRuntime(exec, { secretRootDir });

  try {
    await runtime.retire({ serviceId: "svc-1", workspaceId: "default" });
    assert.deepEqual(calls.map((args) => args[0]), ["rm"]);
    await assert.rejects(fs.stat(serviceDir), /ENOENT/);
  } finally {
    await fs.rm(secretRootDir, { recursive: true, force: true });
  }
});

test("retire removes the persisted egress policy after stopping the container", async () => {
  const events: string[] = [];
  const { exec } = fakeExec((args) => {
    if (args[0] === "rm") events.push("container-removed");
    return {};
  });
  const runtime = createDockerManagedServiceContainerRuntime(exec, {
    egressPolicyRuntime: {
      apply: async () => {},
      remove: async () => { events.push("policy-removed"); },
    },
  });

  await runtime.retire({ serviceId: "svc-1", workspaceId: "default" });
  assert.deepEqual(events, ["container-removed", "policy-removed"]);
});

test("retire surfaces a real removal error", async () => {
  const { exec } = fakeExec((args) => args[0] === "rm" ? { stderr: "permission denied", exitCode: 126 } : {});
  const runtime = createDockerManagedServiceContainerRuntime(exec);

  await assert.rejects(
    runtime.retire({ serviceId: "svc-1", workspaceId: "default" }),
    (error: unknown) => error instanceof DockerContainerError && error.code === "skill_service.container_remove_failed",
  );
});

/* ------------------------------------------------------------------ */
/* Cosign image signature verification (schema v82)                    */
/* ------------------------------------------------------------------ */

const TEST_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFqpQUB2kqJXqZq9Y0Jq0N6nRqZb6
vY1Q6GZPZ5aB0nR4Lz1S8u4jT2qVwzKQm0xEb7jHkY9x0o0I9sM0w==
-----END PUBLIC KEY-----`;

test("buildCosignVerificationArgs pins the key file and digest, skips tlog/SCT", () => {
  const args = buildCosignVerificationArgs("sha256:abc", "/tmp/cosign.pub");
  assert.equal(args[0], "verify");
  assert.equal(args[args.indexOf("--key") + 1], "/tmp/cosign.pub");
  assert.ok(args.includes("--insecure-ignore-sct=true"));
  assert.ok(args.includes("--insecure-ignore-tlog=true"));
  assert.equal(args[args.length - 1], "sha256:abc", "digest-pinned ref is the final arg");
  assert.ok(!args.includes("--allow-insecure-registry"), "bare digest is not an insecure registry");
});

test("buildCosignVerificationArgs allows an insecure registry only for loopback hosts", () => {
  const local = buildCosignVerificationArgs("localhost:5000/dofe-svc-e2e@sha256:abc", "/tmp/cosign.pub");
  assert.ok(local.includes("--allow-insecure-registry"));
  assert.equal(local[local.length - 1], "localhost:5000/dofe-svc-e2e@sha256:abc");

  const remote = buildCosignVerificationArgs("registry.example.com/dofe-svc-e2e@sha256:abc", "/tmp/cosign.pub");
  assert.ok(!remote.includes("--allow-insecure-registry"), "remote registries stay strict");
});

test("verifyManagedServiceImageSignatureSync writes the key and verifies before pull", async () => {
  const { exec, calls } = fakeExec(() => ({}));
  await verifyManagedServiceImageSignatureSync(exec, {
    imageDigest: "sha256:abc",
    signatureKeyPem: TEST_PUBLIC_KEY_PEM,
  });
  assert.equal(calls.length, 1);
  const verify = calls[0]!;
  assert.equal(verify[0], "verify");
  // The cosign.pub temp file must exist at the path we passed.
  const keyPath = verify[verify.indexOf("--key") + 1]!;
  assert.ok(keyPath.endsWith("cosign.pub"), `key path is a cosign.pub file, got ${keyPath}`);
});

test("provision verifies a signature-required image BEFORE the pull and cleans the temp key", async () => {
  const { exec, calls } = fakeExec((args) => {
    if (args[0] === "inspect") return { stdout: "true\n" };
    if (args[0] === "create") return { stdout: "cid\n" };
    return {};
  });
  const runtime = createDockerManagedServiceContainerRuntime(exec, { healthPollIntervalMs: 5, healthWaitMs: 30, cosignExec: exec });
  await runtime.provision({
    ...provisionInput,
    signatureKeyPem: TEST_PUBLIC_KEY_PEM,
    signatureRequired: true,
  });

  const first = calls[0]!;
  assert.equal(first[0], "verify", "signature must be verified before anything else");
  assert.ok(calls.some((c) => c[0] === "pull"), "pull still happens after verify");
  const verifyIdx = calls.findIndex((c) => c[0] === "verify");
  const pullIdx = calls.findIndex((c) => c[0] === "pull");
  assert.ok(verifyIdx >= 0 && pullIdx > verifyIdx, "verify strictly precedes pull");
  const keyPath = first[first.indexOf("--key") + 1]!;
  // The key temp dir is removed after verification.
  const { promises: fsPromises } = await import("node:fs");
  await assert.rejects(fsPromises.stat(keyPath), /ENOENT/, "temp cosign.pub must be cleaned up");
});

test("provision fails closed when cosign verification rejects the image", async () => {
  const { exec, calls } = fakeExec((args) =>
    args[0] === "verify" ? { stderr: "no matching signatures", exitCode: 1 } : {},
  );
  const runtime = createDockerManagedServiceContainerRuntime(exec, { cosignExec: exec });
  await assert.rejects(
    runtime.provision({ ...provisionInput, signatureKeyPem: TEST_PUBLIC_KEY_PEM, signatureRequired: true }),
    (error: unknown) => error instanceof DockerContainerError && error.code === "skill_service.image_signature_verification_failed",
  );
  assert.equal(calls.some((c) => c[0] === "pull"), false, "an unverified image must never be pulled");
});

test("provision requires the trust key when signature enforcement is on", async () => {
  const { exec } = fakeExec(() => ({}));
  const runtime = createDockerManagedServiceContainerRuntime(exec);
  await assert.rejects(
    runtime.provision({ ...provisionInput, signatureRequired: true }),
    (error: unknown) => error instanceof DockerContainerError && error.code === "skill_service.signature_key_missing",
  );
});

test("provision skips signature verification when not required", async () => {
  const { exec, calls } = fakeExec((args) => {
    if (args[0] === "inspect") return { stdout: "true\n" };
    if (args[0] === "create") return { stdout: "cid\n" };
    return {};
  });
  const runtime = createDockerManagedServiceContainerRuntime(exec, { healthPollIntervalMs: 5, healthWaitMs: 30 });
  await runtime.provision(provisionInput);
  assert.equal(calls.some((c) => c[0] === "verify"), false, "no verify step without signatureRequired");
  assert.ok(calls.some((c) => c[0] === "pull"));
});
