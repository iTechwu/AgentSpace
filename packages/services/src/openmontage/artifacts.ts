import { timingSafeEqual } from "node:crypto";
import {
  consumeOpenMontageArtifactReadGrantSync,
  issueOpenMontageArtifactReadGrantSync,
  readOpenMontageJobLinkSync,
  readStoredAttachmentSync,
  type OpenMontageJobLinkRecord,
  type StoredAttachmentRecord,
} from "@dofe-agent/db";
import type { OpenMontageJobAttribution } from "@dofe-agent/domain";
import {
  createAttachmentStorageClient,
  sha256Hex,
  type AttachmentStorageClient,
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
