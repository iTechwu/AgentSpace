import assert from "node:assert/strict";
import test from "node:test";
import type { OpenMontageJobProjection } from "@dofe-agent/domain";
import {
  bindOpenMontageJobDelegationAsync,
  drainPendingOpenMontageJobDelegationsAsync,
  issueOpenMontageModelCredential,
  OpenMontageDelegationAuthenticationError,
} from "./delegations.ts";

const IDS = {
  credential: "00000000-0000-4000-8000-000000000001",
  delegation: "00000000-0000-4000-8000-000000000002",
  tenant: "00000000-0000-4000-8000-000000000003",
  team: "00000000-0000-4000-8000-000000000004",
};

const ATTRIBUTION = {
  workspaceId: "ws-1",
  employeeId: "employee-1",
  runtimeId: "runtime-1",
  rootTaskId: "task-1",
  conversationId: "conversation-1",
  sourceInvocationId: "invocation-1",
  traceId: "task-1",
};

test("binds a models delegation to the immutable Job and escrows only its one-time secret", async () => {
  let modelsBody: Record<string, unknown> | undefined;
  let storedSecret = "";
  let persisted: Record<string, unknown> | undefined;
  const result = await bindOpenMontageJobDelegationAsync({
    ...ATTRIBUTION,
    runtimeCredentialId: IDS.credential,
    connectionId: "connection-1",
    channelName: "direct:employee-1",
    budget: { maxAmount: "20.00", currency: "CNY" },
    snapshot: snapshot(),
  }, {
    resolveScope: () => ({ tenantId: IDS.tenant, teamId: IDS.team }),
    createDelegation: async (input) => {
      modelsBody = input;
      return provisionResponse();
    },
    vault: {
      store: (_id, secret) => {
        storedSecret = secret;
        return { secretRef: "vault://delegation/1" };
      },
      retrieve: () => undefined,
      forget: () => undefined,
    },
    createLink: (input) => {
      persisted = input as unknown as Record<string, unknown>;
      return { jobId: input.snapshot.jobId, ...input, workflowName: "animated-explainer", workflowVersion: "2.0", createdAt: input.snapshot.createdAt };
    },
  });

  assert.equal(modelsBody?.runtimeCredentialId, IDS.credential);
  assert.equal(modelsBody?.sourceInvocationId, "invocation-1");
  assert.equal(modelsBody?.externalJobId, "om_job_1");
  assert.equal(modelsBody?.spendLimit, "20.00");
  assert.equal(modelsBody?.expiresAt, "2026-08-06T09:00:01.000Z");
  assert.deepEqual(modelsBody?.allowedCapabilities, ["image", "video", "tts", "music", "stt"]);
  assert.equal(storedSecret, "delegated-api-key");
  assert.equal((persisted?.delegation as Record<string, unknown>).secretRef, "vault://delegation/1");
  assert.doesNotMatch(JSON.stringify(persisted), /delegated-api-key/);
  assert.equal(result.delegation.delegationId, IDS.delegation);
});

test("returns the escrowed key only to the authenticated matching Job and declared stage", () => {
  let pendingUsage: Record<string, unknown> | undefined;
  const credential = issueOpenMontageModelCredential({
    jobId: "om_job_1",
    stage: "research",
    headers: serviceHeaders(),
    environment: {
      OPENMONTAGE_SERVICE_TOKEN: "service-token",
      MODELS_BASE_URL: "https://models.test/api",
    },
    now: "2026-08-05T10:00:00Z",
  }, {
    readLink: () => link(),
    readDelegation: () => delegation(),
    readProjection: () => projection(),
    vault: { store: () => ({ secretRef: "" }), retrieve: () => "delegated-api-key", forget: () => undefined },
    recordPending: (input) => {
      pendingUsage = input;
      return {} as never;
    },
  });

  assert.equal(credential.apiKey, "delegated-api-key");
  assert.equal(credential.delegationId, IDS.delegation);
  assert.equal(credential.stage, "research");
  assert.equal(pendingUsage?.jobId, "om_job_1");
  assert.equal(pendingUsage?.pipelineStage, "research");
  assert.equal(pendingUsage?.modelInvocationId, "om-pending:om_job_1:research:1");

  assert.throws(() => issueOpenMontageModelCredential({
    jobId: "om_job_1",
    stage: "render",
    headers: serviceHeaders(),
    environment: { OPENMONTAGE_SERVICE_TOKEN: "service-token", MODELS_BASE_URL: "https://models.test/api" },
  }, {
    readLink: () => link(),
    readDelegation: () => delegation(),
    readProjection: () => projection(),
    vault: { store: () => ({ secretRef: "" }), retrieve: () => "delegated-api-key", forget: () => undefined },
    recordPending: () => ({} as never),
  }), OpenMontageDelegationAuthenticationError);
});

test("drain retry isolates one models failure from other terminal Jobs", async () => {
  const attempted: string[] = [];
  const result = await drainPendingOpenMontageJobDelegationsAsync({
    listJobIds: () => ["om_job_1", "om_job_2"],
    drain: async (jobId) => {
      attempted.push(jobId);
      if (jobId === "om_job_1") throw new Error("models unavailable");
    },
  });

  assert.deepEqual(attempted, ["om_job_1", "om_job_2"]);
  assert.deepEqual(result, { attempted: 2, succeeded: 1, failed: 1 });
});

function snapshot() {
  return {
    schemaVersion: 1 as const,
    jobId: "om_job_1",
    status: "QUEUED" as const,
    workflow: { name: "animated-explainer", version: "2.0", stages: [{ code: "research", labelCode: "research", approvalRequired: false }] },
    stages: [{ code: "research", labelCode: "research", approvalRequired: false, approvalStatus: "NOT_REQUIRED" as const, status: "PENDING" as const, attempt: 0 }],
    currentStage: null,
    lastSequence: 1,
    createdAt: "2026-08-05T10:00:01Z",
    updatedAt: "2026-08-05T10:00:01Z",
  };
}

function provisionResponse() {
  return {
    delegation: {
      id: IDS.delegation,
      runtimeCredentialId: IDS.credential,
      tenantId: IDS.tenant,
      teamId: IDS.team,
      employeeId: "employee-1",
      conversationId: "conversation-1",
      rootTaskId: "task-1",
      sourceService: "openmontage",
      sourceInvocationId: "invocation-1",
      externalJobId: "om_job_1",
      allowedCapabilities: ["image", "video", "tts", "music", "stt"],
      allowedModels: [],
      spendLimit: "20.00",
      currency: "CNY",
      status: "active",
      expiresAt: "2026-08-06T09:00:01.000Z",
    },
    secret: { apiKey: "delegated-api-key" },
    secretIssued: true,
  };
}

function link() {
  return { jobId: "om_job_1", ...ATTRIBUTION, runtimeCredentialId: IDS.credential, workflowName: "animated-explainer", workflowVersion: "2.0", createdAt: "2026-08-05T10:00:01Z" };
}

function delegation() {
  return { jobId: "om_job_1", delegationId: IDS.delegation, runtimeCredentialId: IDS.credential, modelsTenantId: IDS.tenant, modelsTeamId: IDS.team, mcpConnectionId: "connection-1", secretRef: "vault://delegation/1", spendLimit: "20.00", currency: "CNY", status: "active", expiresAt: "2026-08-06T09:00:01Z", createdAt: "2026-08-05T10:00:01Z", updatedAt: "2026-08-05T10:00:01Z" };
}

function projection(): OpenMontageJobProjection {
  return { ...snapshot(), lastAppliedSequence: 1, syncStatus: "CURRENT", nextExpectedSequence: 2, artifacts: [] };
}

function serviceHeaders(): Headers {
  return new Headers({
    Authorization: "Bearer service-token",
    "X-Dofe-Job-Attribution": Buffer.from(JSON.stringify(ATTRIBUTION), "utf8").toString("base64url"),
  });
}
