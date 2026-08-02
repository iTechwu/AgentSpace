import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  buildCosignVerificationArgs,
  buildEgressHostsFile,
  buildManagedServiceContainerCreateArgs,
  buildManagedServiceContainerName,
  buildManagedServiceHealthcheckArgs,
  buildManagedServiceInspectArgs,
  buildManagedServiceInternalNetworkName,
  buildManagedServiceNetworkArgs,
  buildManagedServiceResourceArgs,
  computeManagedServiceHealthRevision,
  createDockerManagedServiceContainerRuntime,
  DockerContainerError,
  parseEgressAllowlistHostnames,
  verifyManagedServiceImageSignatureSync,
  type ManagedContainerExec,
} from "./managed-service-runtime.ts";

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

const provisionInput = {
  serviceId: "svc-1",
  workspaceId: "default",
  imageDigest: "sha256:abc",
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

test("create args inject declared secrets as env pairs", () => {
  const args = buildManagedServiceContainerCreateArgs({
    containerName: "dofe-svc-svc-1",
    serviceId: "svc-1",
    workspaceId: "default",
    imageDigest: "sha256:abc",
    network: NETWORK,
    secrets: { RENDER_LICENSE: "sk-secret", API_KEY: "ak-123" },
  });

  const envIndex = args.indexOf("--env");
  assert.ok(envIndex >= 0);
  assert.equal(args[envIndex + 1], "RENDER_LICENSE=sk-secret");
  assert.ok(args.includes("API_KEY=ak-123"));

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
  const ipByHostname = new Map([["fonts.example.com", "203.0.113.10"]]);
  const content = buildEgressHostsFile(["fonts.example.com"], ipByHostname);
  assert.match(content, /127\.0\.0\.1 localhost/);
  assert.match(content, /203\.0\.113\.10 fonts\.example\.com/);
});

test("buildManagedServiceNetworkArgs: missing → shared, empty → internal, non-empty → dns + hosts", () => {
  const shared = buildManagedServiceNetworkArgs({ egressAllowlist: undefined, network: "mgmt", workspaceId: "default" });
  assert.deepEqual(shared.args, ["--network", "mgmt"]);
  assert.equal(shared.internalNetworkName, undefined);

  const internal = buildManagedServiceNetworkArgs({ egressAllowlist: [], network: "mgmt", workspaceId: "default" });
  assert.equal(buildManagedServiceInternalNetworkName("default"), "dofe-svc-internal-default");
  assert.deepEqual(internal.args, ["--network", "dofe-svc-internal-default", "--network", "mgmt"]);
  assert.equal(internal.internalNetworkName, "dofe-svc-internal-default");

  const allow = buildManagedServiceNetworkArgs({
    egressAllowlist: ["fonts.example.com:443"],
    network: "mgmt",
    workspaceId: "default",
    egressHostsFilePath: "/tmp/dofe-hosts",
  });
  assert.ok(allow.args.includes("--dns"));
  assert.ok(allow.args.some((arg) => arg.includes("/etc/hosts")), "hosts file must be mounted");
});

test("provision with an empty allow-list creates an internal network and blocks outbound", async () => {
  const { exec, calls } = fakeExec((args) => {
    switch (args[0]) {
      case "pull": return {};
      case "network": return {};
      case "create": return { stdout: "cid\n" };
      case "start": return {};
      case "inspect": return { stdout: "true\n" };
      default: return { stderr: `unexpected ${args.join(" ")}`, exitCode: 1 };
    }
  });
  const runtime = createDockerManagedServiceContainerRuntime(exec);

  const result = await runtime.provision({
    ...provisionInput,
    networkJson: JSON.stringify({ egressAllowlist: [] }),
  });

  assert.equal(result.endpointRef, "runtime-private://dofe-svc-svc-1");
  const networkCreate = calls.find((args) => args[0] === "network")!;
  assert.deepEqual(networkCreate.slice(0, 4), ["network", "create", "--internal", "dofe-svc-internal-default"]);
  const createCall = calls.find((args) => args[0] === "create")!;
  assert.equal(createCall.filter((arg) => arg === "--network").length, 2, "internal + shared networks");
  assert.ok(createCall.includes("dofe-svc-internal-default"));
});

test("provision with a non-empty allow-list pins hosts and blocks DNS", async () => {
  const { exec, calls } = fakeExec((args) => {
    if (args[0] === "inspect") return { stdout: "true\n" };
    if (args[0] === "create") return { stdout: "cid\n" };
    return {};
  });
  const runtime = createDockerManagedServiceContainerRuntime(exec, {
    lookupHost: async () => ["203.0.113.10"],
  });

  const result = await runtime.provision({
    ...provisionInput,
    networkJson: JSON.stringify({ egressAllowlist: ["fonts.example.com:443"] }),
  });

  assert.equal(result.endpointRef, "runtime-private://dofe-svc-svc-1");
  const createCall = calls.find((args) => args[0] === "create")!;
  assert.ok(createCall.includes("--dns"), "dead DNS blocks unknown hostnames");
  const mount = createCall.find((arg) => arg.startsWith("type=bind,src=") && arg.includes("/etc/hosts"));
  assert.ok(mount, "hosts file must be mounted read-only");
  const hostsSrc = mount!.split("src=")[1]!.split(",")[0]!;
  assert.match(hostsSrc, /dofe-svc-egress-/, "hosts file lives in a scratch dir");
  // Hosts-file CONTENT correctness is covered by buildEgressHostsFile above;
  // the provision writes it then cleans the scratch dir in finally.
  assert.ok(!createCall.includes("dofe-svc-internal"), "non-empty allow-list stays on the shared network");
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
      case "inspect": return { stdout: "true\n" };
      default: return { stderr: `unexpected ${args.join(" ")}`, exitCode: 1 };
    }
  });
  const runtime = createDockerManagedServiceContainerRuntime(exec);

  const result = await runtime.provision(provisionInput);

  assert.equal(result.endpointRef, "runtime-private://dofe-svc-svc-1");
  assert.equal(result.containerName, "dofe-svc-svc-1");
  assert.ok(result.healthRevision.length > 0);
  assert.deepEqual(calls.map((args) => args[0]), ["pull", "create", "start", "inspect"]);
  const inspect = calls[3]!;
  assert.equal(inspect[inspect.indexOf("--format") + 1], "{{.State.Running}}", "no healthcheck → wait for running");
});

test("provision waits for the healthy state when a healthcheck is configured", async () => {
  let healthy = false;
  const { exec } = fakeExec((args) => {
    if (args[0] === "inspect") {
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
  const { exec } = fakeExec((args) => args[0] === "inspect" ? { stdout: "starting\n" } : { stdout: "abc\n" });
  const runtime = createDockerManagedServiceContainerRuntime(exec, { healthPollIntervalMs: 5, healthWaitMs: 30 });

  await assert.rejects(
    runtime.provision({ ...provisionInput, healthJson: JSON.stringify({ path: "/healthz" }) }),
    (error: unknown) => error instanceof DockerContainerError && error.code === "skill_service.container_health_timeout",
  );
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
  const { exec, calls } = fakeExec((args) => args[0] === "rm"
    ? { stderr: "Error response from daemon: No such container: dofe-svc-svc-1", exitCode: 1 }
    : {});
  const runtime = createDockerManagedServiceContainerRuntime(exec);

  await runtime.retire({ serviceId: "svc-1", workspaceId: "default" });
  assert.deepEqual(calls.map((args) => args[0]), ["rm"]);
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
