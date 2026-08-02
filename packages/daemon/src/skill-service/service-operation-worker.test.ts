import assert from "node:assert/strict";
import test from "node:test";
import type { ClaimedManagedSkillServiceOperation } from "@dofe-agent/domain";
import type { HttpDaemonClient } from "../daemon-client.ts";
import type { RemoteDaemonConfig } from "../remote-daemon.ts";
import {
  DockerContainerError,
  type ManagedServiceContainerRuntime,
} from "./managed-service-runtime.ts";
import { executeSkillServiceOperation } from "./service-operation-worker.ts";

function makeOperation(overrides?: Partial<ClaimedManagedSkillServiceOperation>): ClaimedManagedSkillServiceOperation {
  return {
    operationId: "svc-op-1",
    workspaceId: "default",
    runtimeId: "rt-1",
    serviceId: "svc-1",
    installationId: "inst-1",
    operation: "provision",
    status: "claimed",
    catalog: {
      imageDigest: "sha256:abc",
      protocol: "http",
      networkJson: "{}",
      healthJson: "{}",
      resourcesJson: "{}",
    },
    ...overrides,
  };
}

function makeClient() {
  const calls = {
    start: [] as string[],
    complete: [] as Array<{ operationId: string; body: unknown }>,
    fail: [] as Array<{ operationId: string; body: unknown }>,
  };
  const client = {
    startSkillServiceOperation: async (operationId: string) => {
      calls.start.push(operationId);
    },
    completeSkillServiceOperation: async (operationId: string, body: unknown) => {
      calls.complete.push({ operationId, body });
    },
    failSkillServiceOperation: async (operationId: string, body: unknown) => {
      calls.fail.push({ operationId, body });
    },
    renewSkillServiceOperationLease: async () => true,
  } as unknown as HttpDaemonClient;
  return { client, calls };
}

function makeRuntime(overrides?: Partial<ManagedServiceContainerRuntime>): ManagedServiceContainerRuntime {
  return {
    provision: async () => ({
      endpointRef: "runtime-private://dofe-svc-svc-1",
      healthRevision: "rev1",
      containerName: "dofe-svc-svc-1",
    }),
    retire: async () => {},
    ...overrides,
  };
}

const config = { stateDir: "/tmp/test" } as unknown as RemoteDaemonConfig;

test("provision success completes with endpointRef + healthRevision", async () => {
  const { client, calls } = makeClient();
  await executeSkillServiceOperation(client, config, makeOperation(), makeRuntime());

  assert.deepEqual(calls.start, ["svc-op-1"]);
  assert.equal(calls.complete.length, 1);
  assert.equal(calls.complete[0]!.operationId, "svc-op-1");
  assert.equal((calls.complete[0]!.body as { endpointRef: string }).endpointRef, "runtime-private://dofe-svc-svc-1");
  assert.equal((calls.complete[0]!.body as { healthRevision: string }).healthRevision, "rev1");
  assert.deepEqual(JSON.parse((calls.complete[0]!.body as { safeResultJson: string }).safeResultJson), {
    containerName: "dofe-svc-svc-1",
  });
  assert.equal(calls.fail.length, 0);
});

test("provision passes catalog fields to the runtime", async () => {
  const { client } = makeClient();
  const seen: unknown[] = [];
  const runtime = makeRuntime({
    provision: async (input) => {
      seen.push(input);
      return { endpointRef: "runtime-private://x", healthRevision: "r", containerName: "x" };
    },
  });
  await executeSkillServiceOperation(client, config, makeOperation(), runtime);

  assert.deepEqual(seen, [{
    serviceId: "svc-1",
    workspaceId: "default",
    imageDigest: "sha256:abc",
    networkJson: "{}",
    healthJson: "{}",
    resourcesJson: "{}",
  }]);
});

test("provision failure fails the operation with a stable docker code", async () => {
  const { client, calls } = makeClient();
  const runtime = makeRuntime({
    provision: async () => {
      throw new DockerContainerError("skill_service.image_pull_failed", "pull failed");
    },
  });
  await executeSkillServiceOperation(client, config, makeOperation(), runtime);

  assert.equal(calls.complete.length, 0);
  assert.equal(calls.fail.length, 1);
  assert.equal((calls.fail[0]!.body as { errorCode: string }).errorCode, "skill_service.image_pull_failed");
});

test("generic provision failure fails with skill_service.runtime_error", async () => {
  const { client, calls } = makeClient();
  const runtime = makeRuntime({
    provision: async () => {
      throw new Error("boom");
    },
  });
  await executeSkillServiceOperation(client, config, makeOperation(), runtime);

  assert.equal((calls.fail[0]!.body as { errorCode: string }).errorCode, "skill_service.runtime_error");
  assert.match((calls.fail[0]!.body as { errorMessage: string }).errorMessage, /boom/);
});

test("retire completes with an empty body", async () => {
  const { client, calls } = makeClient();
  const retired: unknown[] = [];
  const runtime = makeRuntime({
    retire: async (input) => {
      retired.push(input);
    },
  });
  await executeSkillServiceOperation(client, config, makeOperation({ operation: "retire" }), runtime);

  assert.deepEqual(retired, [{ serviceId: "svc-1", workspaceId: "default" }]);
  assert.equal(calls.complete.length, 1);
  assert.deepEqual(calls.complete[0]!.body, {});
  assert.equal(calls.fail.length, 0);
});

test("retire failure fails the operation with a stable docker code", async () => {
  const { client, calls } = makeClient();
  const runtime = makeRuntime({
    retire: async () => {
      throw new DockerContainerError("skill_service.container_remove_failed", "rm failed");
    },
  });
  await executeSkillServiceOperation(client, config, makeOperation({ operation: "retire" }), runtime);

  assert.equal(calls.complete.length, 0);
  assert.equal((calls.fail[0]!.body as { errorCode: string }).errorCode, "skill_service.container_remove_failed");
});
