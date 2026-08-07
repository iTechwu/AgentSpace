import { OpenMontageArtifactGrantError } from "@dofe-agent/db";
import {
  issueOpenMontageArtifactReadGrant,
  issueOpenMontageArtifactWriteGrant,
  OpenMontageArtifactAuthenticationError,
  OpenMontageArtifactConfigurationError,
  OpenMontageArtifactValidationError,
} from "@dofe-agent/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 4096;

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  try {
    const body = await readJsonObject(request);
    const { jobId } = await context.params;
    const baseUrl = process.env.DOFE_AGENT_INTERNAL_URL?.trim() || new URL(request.url).origin;
    const normalizedJobId = requireIdentifier(jobId, "jobId");
    const grant = body.operation === "WRITE"
      ? issueOpenMontageArtifactWriteGrant({
          jobId: normalizedJobId,
          artifact: readWriteArtifact(body),
          headers: request.headers,
          baseUrl,
        })
      : issueOpenMontageArtifactReadGrant({
          jobId: normalizedJobId,
          attachmentId: readAttachmentId(body),
          headers: request.headers,
          baseUrl,
        });
    return Response.json(grant, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof OpenMontageArtifactAuthenticationError) {
      return Response.json(
        { error: { code: "OPENMONTAGE_ARTIFACT_UNAUTHORIZED" } },
        { status: 401 },
      );
    }
    if (error instanceof OpenMontageArtifactConfigurationError) {
      return Response.json(
        { error: { code: "OPENMONTAGE_ARTIFACT_BRIDGE_NOT_CONFIGURED" } },
        { status: 503 },
      );
    }
    if (
      error instanceof OpenMontageArtifactValidationError
      || error instanceof OpenMontageArtifactGrantError
      || error instanceof SyntaxError
    ) {
      return Response.json(
        { error: { code: "OPENMONTAGE_ARTIFACT_REQUEST_INVALID" } },
        { status: 422 },
      );
    }
    throw error;
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_REQUEST_BYTES) {
    throw new OpenMontageArtifactValidationError("Artifact grant request size is invalid");
  }
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenMontageArtifactValidationError("Artifact grant request must be an object");
  }
  const source = value as Record<string, unknown>;
  return source;
}

function readAttachmentId(body: Record<string, unknown>): string {
  const allowed = new Set(["operation", "attachmentId"]);
  if (
    (body.operation !== undefined && body.operation !== "READ")
    || Object.keys(body).some((key) => !allowed.has(key))
  ) {
    throw new OpenMontageArtifactValidationError("Artifact read grant request has unsupported fields");
  }
  return requireIdentifier(body.attachmentId, "attachmentId");
}

function readWriteArtifact(body: Record<string, unknown>) {
  if (
    Object.keys(body).length !== 2
    || !Object.hasOwn(body, "artifact")
    || !body.artifact
    || typeof body.artifact !== "object"
    || Array.isArray(body.artifact)
  ) {
    throw new OpenMontageArtifactValidationError("Artifact write grant request is invalid");
  }
  const artifact = body.artifact as Record<string, unknown>;
  const expectedKeys = ["fileName", "mediaType", "role", "sha256", "sizeBytes"];
  const actualKeys = Object.keys(artifact).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new OpenMontageArtifactValidationError("Artifact write metadata has invalid fields");
  }
  if (typeof artifact.sizeBytes !== "number" || !Number.isSafeInteger(artifact.sizeBytes)) {
    throw new OpenMontageArtifactValidationError("Artifact sizeBytes is invalid");
  }
  return {
    role: requireIdentifier(artifact.role, "role"),
    fileName: requireIdentifier(artifact.fileName, "fileName"),
    mediaType: requireIdentifier(artifact.mediaType, "mediaType"),
    sizeBytes: artifact.sizeBytes,
    sha256: requireIdentifier(artifact.sha256, "sha256"),
  };
}

function requireIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new OpenMontageArtifactValidationError(`${name} is invalid`);
  }
  return value.trim();
}
