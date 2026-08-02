import type { ClaimedManagedSkillServiceOperation } from "@dofe-agent/domain";
import type { HttpDaemonClient } from "../daemon-client.ts";
import type { RemoteDaemonConfig } from "../remote-daemon.ts";
import {
  createDockerManagedServiceContainerRuntime,
  DockerContainerError,
  type ManagedServiceContainerRuntime,
} from "./managed-service-runtime.ts";

/** Lease heartbeat cadence; must stay well under the control-plane lease (120s). */
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Executes a claimed managed-skill-service operation on a managed node:
 * provision pulls the digest-pinned image and brings the container up (health
 * wait + protocol handshake), retire tears it down. The container runtime is
 * injectable so tests drive a fake without a docker daemon. All state goes over
 * the HTTP client (claim/start/renew/complete/fail) — the daemon stays stateless.
 */
export async function executeSkillServiceOperation(
  client: HttpDaemonClient,
  config: RemoteDaemonConfig,
  operation: ClaimedManagedSkillServiceOperation,
  runtime: ManagedServiceContainerRuntime = createDockerManagedServiceContainerRuntime(),
): Promise<void> {
  await client.startSkillServiceOperation(operation.operationId, operation.claimGeneration);

  // Lease heartbeat: if the lease is lost (crash recovery re-queued the op) the
  // completion would be fenced by the control plane, so abort before reporting.
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void client.renewSkillServiceOperationLease(operation.operationId, operation.claimGeneration)
      .then((renewed) => {
        if (!renewed) {
          leaseLost = true;
        }
      })
      .catch(() => {
        // Transient renew failure is not fatal; the next beat retries.
      });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  let secrets: Record<string, string> = {};
  try {
    let provisioned: Awaited<ReturnType<ManagedServiceContainerRuntime["provision"]>> | undefined;
    if (operation.operation === "retire") {
      await runtime.retire({ serviceId: operation.serviceId, workspaceId: operation.workspaceId });
    } else {
      // Secrets are fetched over the authenticated channel AFTER claim, never in
      // the audited claim payload, and injected as container env.
      secrets = await client.getSkillServiceSecrets(operation.operationId, operation.claimGeneration);
      provisioned = await runtime.provision({
        serviceId: operation.serviceId,
        workspaceId: operation.workspaceId,
        imageDigest: operation.catalog.imageDigest,
        networkJson: operation.catalog.networkJson,
        healthJson: operation.catalog.healthJson,
        resourcesJson: operation.catalog.resourcesJson,
        runAsNonRoot: operation.catalog.runAsNonRoot,
        readOnlyRootfs: operation.catalog.readOnlyRootfs,
        capDrop: operation.catalog.capDrop,
        signatureKeyPem: operation.catalog.signatureKeyPem,
        signatureRequired: operation.catalog.signatureRequired,
        secrets,
      });
    }

    if (leaseLost) {
      throw new Error("skill_service.lease_lost: operation lease expired while executing; aborting.");
    }

    if (operation.operation === "retire") {
      await client.completeSkillServiceOperation(operation.operationId, {
        claimGeneration: operation.claimGeneration,
      });
    } else {
      await client.completeSkillServiceOperation(operation.operationId, {
        claimGeneration: operation.claimGeneration,
        endpointRef: provisioned!.endpointRef,
        healthRevision: provisioned!.healthRevision,
        safeResultJson: JSON.stringify({ containerName: provisioned!.containerName }),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client.failSkillServiceOperation(operation.operationId, {
      claimGeneration: operation.claimGeneration,
      errorCode: error instanceof DockerContainerError
        ? error.code
        : "skill_service.runtime_error",
      // A container error must never leak a secret value back to the control plane.
      errorMessage: redactSecretValues(message, secrets),
    });
  } finally {
    clearInterval(heartbeat);
  }
}

/** Replaces every known secret value in a message with *** (len > 0 only). */
function redactSecretValues(message: string, secrets: Record<string, string>): string {
  let redacted = message;
  for (const value of Object.values(secrets)) {
    if (value.length > 0 && redacted.includes(value)) {
      redacted = redacted.split(value).join("***");
    }
  }
  return redacted;
}
