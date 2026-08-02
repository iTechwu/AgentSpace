import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { getDatabase, randomLikeId } from "@dofe-agent/db";
import {
  claimNextManagedSkillServiceOperationForRuntimeSync,
  createManagedSkillServiceOperationSync,
  createManagedSkillServiceSync,
  listManagedSkillServiceOperationsSync,
  readManagedSkillServiceSync,
} from "@dofe-agent/db";
import {
  completeManagedSkillServiceProvisionOperationSync,
  completeManagedSkillServiceRetireOperationSync,
  createSkillServiceCatalogEntrySync,
  queueManagedSkillServiceRetireSync,
  resetWorkspaceStateSync,
  resolveClaimedManagedSkillServiceOperation,
} from "@dofe-agent/services";
import {
  createDockerManagedServiceContainerRuntime,
  type ManagedServiceContainerRuntime,
} from "./managed-service-runtime.ts";

const execFileP = promisify(execFile);

/**
 * REAL-DOCKER end-to-end for the skill-service managed-node path (the last
 * remaining gap): the actual `createDockerManagedServiceContainerRuntime`
 * against a live docker daemon + real cosign, verifying a signed image from a
 * registry BEFORE pulling it, then provisioning/retiring the container through
 * the real control-plane lifecycle.
 *
 * Gated: only runs when DOFE_AGENT_RUN_DOCKER_E2E=1 AND the signed image ref +
 * cosign public key are supplied (see scripts/dofe-svc-e2e-setup.sh). It must
 * run standalone (shared agent_space_test PG DB, one file per invocation).
 */
const RUN_E2E = process.env.DOFE_AGENT_RUN_DOCKER_E2E === "1";
const IMAGE_REF = process.env.DOFE_AGENT_E2E_IMAGE_REF ?? "";
const COSIGN_PUB_FILE = process.env.DOFE_AGENT_E2E_COSIGN_PUB_FILE ?? "";

let ready = RUN_E2E && Boolean(IMAGE_REF && COSIGN_PUB_FILE);
let cosignPubKeyPem = "";

async function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { timeout: 120_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? String(error) };
  }
}

before(async () => {
  process.env.NODE_ENV = "test";
  if (!ready) {
    return;
  }
  // Confirm the daemon + cosign + signed image are actually reachable.
  const docker = await run("docker", ["version", "--format", "{{.Server.Version}}"]);
  const cosign = await run(process.env.COSIGN_BIN ?? "cosign", ["version"]);
  if (docker.code !== 0 || cosign.code !== 0) {
    ready = false;
    return;
  }
  cosignPubKeyPem = await fs.readFile(COSIGN_PUB_FILE, "utf8");
});

beforeEach(() => {
  resetWorkspaceStateSync();
});

after(() => {
  resetWorkspaceStateSync();
});

function createTestRuntime(): string {
  const id = `rt-${randomLikeId()}`;
  const now = new Date().toISOString();
  getDatabase().prepare(
    `INSERT INTO agent_runtime (id, workspace_id, provider, name, status, created_at, updated_at)
     VALUES (?, 'default', 'test-provider', ?, 'online', ?, ?)`,
  ).run(id, `E2E Runtime ${id}`, now, now);
  return id;
}

function seedSignedCatalog(runtimeId: string): string {
  // Unique slug per run: the catalog is immutable-first-write, so a shared test
  // DB would otherwise reuse a stale catalog from an earlier E2E run.
  const slug = `dofe-svc-e2e-${randomLikeId()}`;
  return createSkillServiceCatalogEntrySync({
    workspaceId: "default",
    slug,
    templateVersion: "1.0.0",
    deploymentType: "managed_service",
    imageDigest: IMAGE_REF,
    templateDigest: `sha256:${"t".repeat(64)}`,
    sbomDigest: `sha256:${"e".repeat(64)}`,
    networkJson: JSON.stringify({ egressAllowlist: [] }),
    healthJson: JSON.stringify({ path: "/healthz", port: 8080 }),
    // docker suffixes only (m/g/k); K8s `Mi` is rejected by `docker create`.
    resourcesJson: JSON.stringify({ memory: "64m", cpu: "0.1" }),
    runAsNonRoot: true,
    readOnlyRootfs: true,
    capDrop: ["ALL"],
    signatureKeyPem: cosignPubKeyPem,
    signatureRequired: true,
  }).id;
}

/** Maps the claim payload to the runtime provision input exactly as the worker does. */
function toProvisionInput(claimed: NonNullable<ReturnType<typeof resolveClaimedManagedSkillServiceOperation>>) {
  return {
    serviceId: claimed.serviceId,
    workspaceId: claimed.workspaceId,
    imageDigest: claimed.catalog.imageDigest,
    networkJson: claimed.catalog.networkJson,
    healthJson: claimed.catalog.healthJson,
    resourcesJson: claimed.catalog.resourcesJson,
    runAsNonRoot: claimed.catalog.runAsNonRoot,
    readOnlyRootfs: claimed.catalog.readOnlyRootfs,
    capDrop: claimed.catalog.capDrop,
    signatureKeyPem: claimed.catalog.signatureKeyPem,
    signatureRequired: claimed.catalog.signatureRequired,
    secrets: {},
  };
}

test("REAL DOCKER: signature-required provision verifies with cosign, brings the container up, and completes to ready", async (t) => {
  if (!ready) {
    t.skip("docker/cosign E2E not configured (DOFE_AGENT_RUN_DOCKER_E2E=1 + image ref + cosign pub).");
    return;
  }
  const runtime: ManagedServiceContainerRuntime = createDockerManagedServiceContainerRuntime();
  const runtimeId = createTestRuntime();
  const catalogId = seedSignedCatalog(runtimeId);

  const service = createManagedSkillServiceSync({
    workspaceId: "default",
    runtimeId,
    catalogId,
    status: "provisioning",
  });
  createManagedSkillServiceOperationSync({
    workspaceId: "default",
    runtimeId,
    serviceId: service.id,
    operation: "provision",
  });

  const claimed = claimNextManagedSkillServiceOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(claimed);
  assert.equal(claimed.operation, "provision");
  const payload = resolveClaimedManagedSkillServiceOperation(claimed);
  assert.ok(payload);
  assert.equal(payload.catalog.signatureRequired, true);
  assert.equal(payload.catalog.signatureKeyPem, cosignPubKeyPem.trim(), "claim carries the trimmed PEM trust anchor");

  // Real cosign verify → docker pull → network → create → start → health.
  const provisioned = await runtime.provision(toProvisionInput(payload));

  assert.ok(provisioned.endpointRef.startsWith("runtime-private://"));
  assert.ok(provisioned.containerName, "container name reported");
  assert.equal(readManagedSkillServiceSync(service.id, "default")?.status, "provisioning", "still provisioning until complete");

  // The real container is up and healthy on the host.
  const inspect = await run("docker", ["inspect", "--format", "{{.State.Running}}", provisioned.containerName]);
  assert.equal(inspect.stdout.trim(), "true", "container is running after health wait");

  // Complete through the real control plane → service ready (no binding; no installation).
  const completed = completeManagedSkillServiceProvisionOperationSync({
    operationId: claimed.id,
    workspaceId: "default",
    claimGeneration: claimed.claimGeneration,
    endpointRef: provisioned.endpointRef,
    healthRevision: provisioned.healthRevision,
  });
  assert.equal(completed.ok, true);
  assert.equal(readManagedSkillServiceSync(service.id, "default")?.status, "ready");

  t.diagnostic(`provisioned ${provisioned.containerName} → ${provisioned.endpointRef}`);
});

test("REAL DOCKER: retire removes the container and the service reaches retired", async (t) => {
  if (!ready) {
    t.skip("docker/cosign E2E not configured.");
    return;
  }
  const runtime: ManagedServiceContainerRuntime = createDockerManagedServiceContainerRuntime();
  const runtimeId = createTestRuntime();
  const catalogId = seedSignedCatalog(runtimeId);
  const service = createManagedSkillServiceSync({
    workspaceId: "default",
    runtimeId,
    catalogId,
    status: "ready",
  });
  const containerName = `dofe-svc-${service.id}`;

  // Queue + claim the retire op, then tear the real container down.
  const queued = queueManagedSkillServiceRetireSync({ workspaceId: "default", serviceId: service.id });
  assert.equal(queued.queued, true);
  const retireOp = claimNextManagedSkillServiceOperationForRuntimeSync({ workspaceId: "default", runtimeId });
  assert.ok(retireOp);
  assert.equal(retireOp.operation, "retire");

  await runtime.retire({ serviceId: service.id, workspaceId: "default" });

  const gone = await run("docker", ["inspect", "--format", "{{.State.Running}}", containerName]);
  assert.equal(gone.code !== 0, true, "container must be gone after retire");

  const completed = completeManagedSkillServiceRetireOperationSync({
    operationId: retireOp.id,
    workspaceId: "default",
    claimGeneration: retireOp.claimGeneration,
  });
  assert.equal(completed.ok, true);
  assert.equal(readManagedSkillServiceSync(service.id, "default")?.status, "retired");
});
