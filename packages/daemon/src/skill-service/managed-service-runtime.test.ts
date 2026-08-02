import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  buildManagedServiceContainerCreateArgs,
  buildManagedServiceContainerName,
  buildManagedServiceHealthcheckArgs,
  buildManagedServiceInspectArgs,
  buildManagedServiceResourceArgs,
  computeManagedServiceHealthRevision,
  createDockerManagedServiceContainerRuntime,
  DockerContainerError,
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
