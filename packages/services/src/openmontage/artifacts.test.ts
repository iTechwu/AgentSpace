import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { AttachmentStorageClient } from "../attachments/storage.ts";
import {
  issueOpenMontageArtifactReadGrant,
  OpenMontageArtifactAuthenticationError,
  resolveOpenMontageArtifactReadDownload,
} from "./artifacts.ts";

const ATTRIBUTION = {
  workspaceId: "ws-1",
  employeeId: "employee-1",
  runtimeId: "runtime-1",
  rootTaskId: "task-1",
  conversationId: "conversation-1",
  sourceInvocationId: "invocation-1",
  traceId: "trace-1",
};

const LINK = {
  jobId: "om_job_1",
  ...ATTRIBUTION,
  workflowName: "animated-explainer",
  workflowVersion: "2.0",
  createdAt: "2026-08-05T10:00:00Z",
};

const ATTACHMENT = {
  workspaceId: "ws-1",
  id: "att-video-1",
  channelName: "direct:employee-1",
  speaker: "User",
  role: "human",
  fileName: "reference.mp4",
  mediaType: "video/mp4",
  kind: "file" as const,
  sizeBytes: 5,
  storedPath: "tos://bucket/reference.mp4",
  storageProvider: "tos" as const,
  storageBucket: "bucket",
  storageKey: "reference.mp4",
  sha256: createHash("sha256").update("video").digest("hex"),
  sourceMessageIndex: 0,
  createdAt: "2026-08-05T10:00:00Z",
};

function serviceHeaders(attribution = ATTRIBUTION): Headers {
  return new Headers({
    Authorization: "Bearer service-token",
    "X-Dofe-Job-Attribution": Buffer.from(JSON.stringify(attribution), "utf8").toString("base64url"),
  });
}

test("issues a download contract only for an authenticated matching Job binding", () => {
  const issued = issueOpenMontageArtifactReadGrant({
    jobId: "om_job_1",
    attachmentId: "att-video-1",
    headers: serviceHeaders(),
    baseUrl: "http://agentspace.internal:1455",
    environment: { OPENMONTAGE_SERVICE_TOKEN: "service-token" },
  }, {
    readLink: () => LINK,
    readAttachment: () => ATTACHMENT,
    issueGrant: () => ({
      token: "grant-token",
      grant: {
        id: "om_ag_1",
        workspaceId: "ws-1",
        jobId: "om_job_1",
        attachmentId: "att-video-1",
        operation: "READ",
        expiresAt: "2026-08-05T10:05:00Z",
        createdAt: "2026-08-05T10:00:00Z",
      },
    }),
  });

  assert.deepEqual(issued, {
    schemaVersion: 1,
    grantId: "om_ag_1",
    operation: "READ",
    downloadUrl: "http://agentspace.internal:1455/api/internal/openmontage/artifact-grants/om_ag_1",
    token: "grant-token",
    expiresAt: "2026-08-05T10:05:00Z",
    artifact: {
      artifactId: "att-video-1",
      fileName: "reference.mp4",
      mediaType: "video/mp4",
      sizeBytes: 5,
      sha256: ATTACHMENT.sha256,
    },
  });

  assert.throws(
    () => issueOpenMontageArtifactReadGrant({
      jobId: "om_job_1",
      attachmentId: "att-video-1",
      headers: serviceHeaders({ ...ATTRIBUTION, employeeId: "employee-2" }),
      baseUrl: "http://agentspace.internal:1455",
      environment: { OPENMONTAGE_SERVICE_TOKEN: "service-token" },
    }, {
      readLink: () => LINK,
      readAttachment: () => ATTACHMENT,
      issueGrant: () => { throw new Error("must not issue"); },
    }),
    OpenMontageArtifactAuthenticationError,
  );
});

test("consumes the bearer grant and redirects object storage downloads", async () => {
  let consumedToken = "";
  const result = await resolveOpenMontageArtifactReadDownload({
    grantId: "om_ag_1",
    headers: new Headers({ Authorization: "Bearer one-time-token" }),
  }, {
    consumeGrant: (input) => {
      consumedToken = input.token;
      return {
        grant: {
          id: "om_ag_1",
          workspaceId: "ws-1",
          jobId: "om_job_1",
          attachmentId: "att-video-1",
          operation: "READ",
          expiresAt: "2026-08-05T10:05:00Z",
          consumedAt: "2026-08-05T10:00:01Z",
          createdAt: "2026-08-05T10:00:00Z",
        },
        attachment: ATTACHMENT,
      };
    },
    storage: storageWith({ readUrl: "https://bucket.example.com/reference.mp4" }),
  });

  assert.equal(consumedToken, "one-time-token");
  assert.deepEqual(result, {
    kind: "redirect",
    url: "https://bucket.example.com/reference.mp4",
    attachment: ATTACHMENT,
  });
});

test("local download fallback verifies stored bytes against the grant metadata", async () => {
  const consumeGrant = () => ({
    grant: {
      id: "om_ag_1",
      workspaceId: "ws-1",
      jobId: "om_job_1",
      attachmentId: "att-video-1",
      operation: "READ" as const,
      expiresAt: "2026-08-05T10:05:00Z",
      consumedAt: "2026-08-05T10:00:01Z",
      createdAt: "2026-08-05T10:00:00Z",
    },
    attachment: ATTACHMENT,
  });

  const result = await resolveOpenMontageArtifactReadDownload({
    grantId: "om_ag_1",
    headers: new Headers({ Authorization: "Bearer one-time-token" }),
  }, {
    consumeGrant,
    storage: storageWith({ bytes: Buffer.from("video") }),
  });
  assert.equal(result.kind, "bytes");
  assert.equal(Buffer.from(result.bytes).toString("utf8"), "video");

  await assert.rejects(
    resolveOpenMontageArtifactReadDownload({
      grantId: "om_ag_2",
      headers: new Headers({ Authorization: "Bearer another-token" }),
    }, {
      consumeGrant,
      storage: storageWith({ bytes: Buffer.from("tampered") }),
    }),
    /integrity/,
  );
});

function storageWith(input: { readUrl?: string; bytes?: Uint8Array }): AttachmentStorageClient {
  return {
    putObject: async () => { throw new Error("unused"); },
    putObjectSync: () => { throw new Error("unused"); },
    getObject: async () => input.bytes ?? new Uint8Array(),
    getObjectSync: () => input.bytes ?? new Uint8Array(),
    headObject: async () => null,
    deleteObject: async () => undefined,
    deleteObjectSync: () => undefined,
    createReadUrl: async () => input.readUrl ?? null,
    putContentAddressedBlobSync: () => { throw new Error("unused"); },
    getContentAddressedBlobSync: () => { throw new Error("unused"); },
    contentAddressedBlobExistsSync: () => false,
    deleteContentAddressedBlobSync: () => undefined,
  };
}
