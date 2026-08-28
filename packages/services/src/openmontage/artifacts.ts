import { timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import {
  consumeOpenMontageArtifactReadGrantSync,
  consumeOpenMontageArtifactWriteGrantSync,
  issueOpenMontageArtifactReadGrantSync,
  issueOpenMontageArtifactWriteGrantSync,
  publishEmployeeArtifactSync,
  readOpenMontageJobLinkSync,
  readStoredEmployeeByIdSync,
  readStoredAttachmentSync,
  upsertContentBlobSync,
  type OpenMontageJobLinkRecord,
  type StoredAttachmentRecord,
} from "@dofe-agent/db";
import type { OpenMontageJobAttribution } from "@dofe-agent/domain";
import {
  ContentAddressedBlobIntegrityError,
  createAttachmentStorageClient,
  sha256Hex,
  type AttachmentStorageClient,
  type ContentAddressedBlobRef,
} from "../attachments/storage.ts";

const ATTRIBUTION_KEYS = [
  "conversationId",
  "employeeId",
  "rootTaskId",
  "runtimeId",
  "sourceInvocationId",
  "traceId",
  "workspaceId",
] as const;

export interface OpenMontageArtifactReadGrantDocument {
  schemaVersion: 1;
  grantId: string;
  operation: "READ";
  downloadUrl: string;
  token: string;
  expiresAt: string;
  artifact: {
    artifactId: string;
    fileName: string;
    mediaType: string;
    sizeBytes: number;
    sha256: string;
  };
}

export interface OpenMontageArtifactWriteGrantDocument {
  schemaVersion: 1;
  grantId: string;
  operation: "WRITE";
  uploadUrl: string;
  token: string;
  expiresAt: string;
  artifact: OpenMontageOutputArtifactMetadata;
}

export interface OpenMontageOutputArtifactMetadata {
  role: string;
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
}

export interface OpenMontagePublishedArtifactDocument extends OpenMontageOutputArtifactMetadata {
  schemaVersion: 1;
  jobId: string;
  employeeArtifactId: string;
  employeeId: string;
  publishedAt: string;
}

export type OpenMontageArtifactReadDownload =
  | { kind: "redirect"; url: string; attachment: StoredAttachmentRecord }
  | { kind: "bytes"; bytes: Uint8Array; attachment: StoredAttachmentRecord };

export class OpenMontageArtifactAuthenticationError extends Error {}
export class OpenMontageArtifactConfigurationError extends Error {}
export class OpenMontageArtifactValidationError extends Error {}

export function issueOpenMontageArtifactReadGrant(
  input: {
    jobId: string;
    attachmentId: string;
    headers: Headers;
    baseUrl: string;
    environment?: Record<string, string | undefined>;
    now?: string;
  },
  options: {
    readLink?: typeof readOpenMontageJobLinkSync;
    readAttachment?: typeof readStoredAttachmentSync;
    issueGrant?: typeof issueOpenMontageArtifactReadGrantSync;
  } = {},
): OpenMontageArtifactReadGrantDocument {
  const environment = input.environment ?? process.env;
  const attribution = authenticateServiceRequest(
    input.headers,
    environment.OPENMONTAGE_SERVICE_TOKEN,
  );
  const link = (options.readLink ?? readOpenMontageJobLinkSync)(input.jobId);
  if (!link || !matchesAttribution(link, attribution)) {
    throw new OpenMontageArtifactAuthenticationError(
      "OpenMontage Job attribution does not match its trusted binding",
    );
  }
  const attachment = (options.readAttachment ?? readStoredAttachmentSync)(
    link.workspaceId,
    input.attachmentId,
  );
  if (!attachment) {
    throw new OpenMontageArtifactValidationError("OpenMontage input attachment is unavailable");
  }
  const sha256 = requireSha256(attachment.sha256);
  if (!attachment.storageKey || attachment.sizeBytes < 0) {
    throw new OpenMontageArtifactValidationError(
      "OpenMontage input attachment storage metadata is incomplete",
    );
  }

  const issued = (options.issueGrant ?? issueOpenMontageArtifactReadGrantSync)({
    workspaceId: link.workspaceId,
    jobId: link.jobId,
    attachmentId: attachment.id,
    now: input.now,
  });
  const baseUrl = parseServiceBaseUrl(input.baseUrl);
  const downloadUrl = new URL(
    `/api/internal/openmontage/artifact-grants/${encodeURIComponent(issued.grant.id)}`,
    baseUrl,
  ).toString();

  return {
    schemaVersion: 1,
    grantId: issued.grant.id,
    operation: "READ",
    downloadUrl,
    token: issued.token,
    expiresAt: issued.grant.expiresAt,
    artifact: {
      artifactId: attachment.id,
      fileName: attachment.fileName,
      mediaType: attachment.mediaType,
      sizeBytes: attachment.sizeBytes,
      sha256,
    },
  };
}

export async function resolveOpenMontageArtifactReadDownload(
  input: {
    grantId: string;
    headers: Headers;
    now?: string;
  },
  options: {
    consumeGrant?: typeof consumeOpenMontageArtifactReadGrantSync;
    storage?: AttachmentStorageClient;
  } = {},
): Promise<OpenMontageArtifactReadDownload> {
  const token = readBearerToken(input.headers);
  const consumed = (options.consumeGrant ?? consumeOpenMontageArtifactReadGrantSync)({
    grantId: input.grantId,
    token,
    now: input.now,
  });
  const attachment = consumed.attachment;
  const storage = options.storage ?? createAttachmentStorageClient();
  const storageInput = toStorageReadInput(attachment);
  const readUrl = await storage.createReadUrl(storageInput);
  if (readUrl) {
    const parsed = new URL(readUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new OpenMontageArtifactValidationError(
        "OpenMontage attachment storage returned an unsafe download URL",
      );
    }
    return { kind: "redirect", url: parsed.toString(), attachment };
  }

  const bytes = await storage.getObject(storageInput);
  const expectedSha256 = requireSha256(attachment.sha256);
  if (bytes.byteLength !== attachment.sizeBytes || sha256Hex(bytes) !== expectedSha256) {
    throw new OpenMontageArtifactValidationError(
      "OpenMontage input attachment integrity verification failed",
    );
  }
  return { kind: "bytes", bytes, attachment };
}

export function issueOpenMontageArtifactWriteGrant(
  input: {
    jobId: string;
    headers: Headers;
    baseUrl: string;
    artifact: OpenMontageOutputArtifactMetadata;
    environment?: Record<string, string | undefined>;
    now?: string;
  },
  options: {
    readLink?: typeof readOpenMontageJobLinkSync;
    issueGrant?: typeof issueOpenMontageArtifactWriteGrantSync;
  } = {},
): OpenMontageArtifactWriteGrantDocument {
  const environment = input.environment ?? process.env;
  const attribution = authenticateServiceRequest(
    input.headers,
    environment.OPENMONTAGE_SERVICE_TOKEN,
  );
  const link = (options.readLink ?? readOpenMontageJobLinkSync)(input.jobId);
  if (!link || !matchesAttribution(link, attribution)) {
    throw new OpenMontageArtifactAuthenticationError(
      "OpenMontage Job attribution does not match its trusted binding",
    );
  }
  const issued = (options.issueGrant ?? issueOpenMontageArtifactWriteGrantSync)({
    workspaceId: link.workspaceId,
    jobId: link.jobId,
    ...input.artifact,
    now: input.now,
  });
  const baseUrl = parseServiceBaseUrl(input.baseUrl);
  const uploadUrl = new URL(
    `/api/internal/openmontage/artifact-grants/${encodeURIComponent(issued.grant.id)}`,
    baseUrl,
  ).toString();
  return {
    schemaVersion: 1,
    grantId: issued.grant.id,
    operation: "WRITE",
    uploadUrl,
    token: issued.token,
    expiresAt: issued.grant.expiresAt,
    artifact: {
      role: issued.grant.role,
      fileName: issued.grant.fileName,
      mediaType: issued.grant.mediaType,
      sizeBytes: issued.grant.sizeBytes,
      sha256: issued.grant.sha256,
    },
  };
}

export async function publishOpenMontageArtifactUpload(
  input: {
    grantId: string;
    headers: Headers;
    content: Readable;
    now?: string;
  },
  options: {
    consumeGrant?: typeof consumeOpenMontageArtifactWriteGrantSync;
    readLink?: typeof readOpenMontageJobLinkSync;
    readEmployee?: typeof readStoredEmployeeByIdSync;
    storage?: AttachmentStorageClient;
    upsertBlob?: typeof upsertContentBlobSync;
    publishArtifact?: typeof publishEmployeeArtifactSync;
  } = {},
): Promise<OpenMontagePublishedArtifactDocument> {
  const token = readBearerToken(input.headers);
  const grant = (options.consumeGrant ?? consumeOpenMontageArtifactWriteGrantSync)({
    grantId: input.grantId,
    token,
    now: input.now,
  });
  const link = (options.readLink ?? readOpenMontageJobLinkSync)(grant.jobId);
  if (!link || link.workspaceId !== grant.workspaceId) {
    throw new OpenMontageArtifactValidationError(
      "OpenMontage output grant no longer has a valid Job binding",
    );
  }
  const employee = (options.readEmployee ?? readStoredEmployeeByIdSync)(
    link.employeeId,
    link.workspaceId,
  );
  if (!employee || employee.id !== link.employeeId) {
    throw new OpenMontageArtifactValidationError(
      "OpenMontage output grant no longer has a valid employee binding",
    );
  }
  const storage = options.storage ?? createAttachmentStorageClient();
  if (!storage.putContentAddressedBlobStream) {
    throw new OpenMontageArtifactConfigurationError(
      "Attachment storage does not support streaming Artifact Bridge uploads",
    );
  }
  let ref: ContentAddressedBlobRef;
  try {
    ref = await storage.putContentAddressedBlobStream({
      workspaceId: grant.workspaceId,
      sha256: grant.sha256,
      content: input.content,
      sizeBytes: grant.sizeBytes,
      mediaType: grant.mediaType,
    });
  } catch (error) {
    if (error instanceof ContentAddressedBlobIntegrityError) {
      throw new OpenMontageArtifactValidationError(
        "OpenMontage output artifact integrity verification failed",
      );
    }
    throw error;
  }
  (options.upsertBlob ?? upsertContentBlobSync)({
    workspaceId: grant.workspaceId,
    sha256: grant.sha256,
    storageProvider: ref.storageProvider,
    storageBucket: ref.storageBucket,
    storageRegion: ref.storageRegion,
    storageEndpoint: ref.storageEndpoint,
    storageKey: ref.storageKey,
    sizeBytes: grant.sizeBytes,
    mediaType: grant.mediaType,
  });
  const artifact = (options.publishArtifact ?? publishEmployeeArtifactSync)({
    workspaceId: grant.workspaceId,
    employeeName: employee.name,
    contentDigest: grant.sha256,
    mediaType: grant.mediaType,
    fileName: grant.fileName,
    sizeBytes: grant.sizeBytes,
    sourceTaskId: link.rootTaskId,
  });
  return {
    schemaVersion: 1,
    jobId: grant.jobId,
    employeeArtifactId: artifact.id,
    employeeId: link.employeeId,
    role: grant.role,
    fileName: grant.fileName,
    mediaType: grant.mediaType,
    sizeBytes: grant.sizeBytes,
    sha256: grant.sha256,
    publishedAt: artifact.publishedAt,
  };
}

function authenticateServiceRequest(
  headers: Headers,
  configuredToken: string | undefined,
): OpenMontageJobAttribution {
  const serviceToken = configuredToken?.trim();
  if (!serviceToken) {
    throw new OpenMontageArtifactConfigurationError(
      "OPENMONTAGE_SERVICE_TOKEN is required for Artifact Bridge",
    );
  }
  const actualToken = readBearerToken(headers);
  if (!secretsMatch(serviceToken, actualToken)) {
    throw new OpenMontageArtifactAuthenticationError("OpenMontage service authentication failed");
  }
  const encoded = headers.get("X-Dofe-Job-Attribution");
  if (!encoded) {
    throw new OpenMontageArtifactAuthenticationError("Trusted OpenMontage Job attribution is required");
  }
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    return parseAttribution(decoded);
  } catch (error) {
    if (error instanceof OpenMontageArtifactAuthenticationError) throw error;
    throw new OpenMontageArtifactAuthenticationError("Trusted OpenMontage Job attribution is invalid");
  }
}

function parseAttribution(value: unknown): OpenMontageJobAttribution {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenMontageArtifactAuthenticationError("Trusted OpenMontage Job attribution is invalid");
  }
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  if (keys.length !== ATTRIBUTION_KEYS.length || keys.some((key, index) => key !== ATTRIBUTION_KEYS[index])) {
    throw new OpenMontageArtifactAuthenticationError("Trusted OpenMontage Job attribution has invalid fields");
  }
  const result: Record<string, string> = {};
  for (const key of ATTRIBUTION_KEYS) {
    const entry = source[key];
    if (typeof entry !== "string" || !entry.trim() || entry.length > 256) {
      throw new OpenMontageArtifactAuthenticationError(`Trusted attribution ${key} is invalid`);
    }
    result[key] = entry;
  }
  return result as unknown as OpenMontageJobAttribution;
}

function matchesAttribution(
  link: OpenMontageJobLinkRecord,
  attribution: OpenMontageJobAttribution,
): boolean {
  return link.workspaceId === attribution.workspaceId
    && link.employeeId === attribution.employeeId
    && link.runtimeId === attribution.runtimeId
    && link.rootTaskId === attribution.rootTaskId
    && link.conversationId === attribution.conversationId
    && link.sourceInvocationId === attribution.sourceInvocationId
    && link.traceId === attribution.traceId;
}

function readBearerToken(headers: Headers): string {
  const authorization = headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer ([^\s]+)$/);
  if (!match?.[1]) {
    throw new OpenMontageArtifactAuthenticationError("OpenMontage bearer token is required");
  }
  return match[1];
}

function secretsMatch(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseServiceBaseUrl(value: string): URL {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new Error("unsafe URL");
    }
    return url;
  } catch {
    throw new OpenMontageArtifactConfigurationError(
      "AgentSpace Artifact Bridge base URL must be a credential-free HTTP(S) URL",
    );
  }
}

function requireSha256(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !/^[a-f0-9]{64}$/.test(normalized)) {
    throw new OpenMontageArtifactValidationError(
      "OpenMontage input attachment requires a valid SHA-256 digest",
    );
  }
  return normalized;
}

function toStorageReadInput(attachment: StoredAttachmentRecord) {
  return {
    storageProvider: attachment.storageProvider,
    storageBucket: attachment.storageBucket,
    storageRegion: attachment.storageRegion,
    storageEndpoint: attachment.storageEndpoint,
    storageKey: attachment.storageKey,
    storedPath: attachment.storedPath,
  };
}
