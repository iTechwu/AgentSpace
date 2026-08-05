import { OpenMontageArtifactGrantError } from "@dofe-agent/db";
import {
  issueOpenMontageArtifactReadGrant,
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
    const attachmentId = requireIdentifier(body.attachmentId, "attachmentId");
    const { jobId } = await context.params;
    const baseUrl = process.env.DOFE_AGENT_INTERNAL_URL?.trim() || new URL(request.url).origin;
    const grant = issueOpenMontageArtifactReadGrant({
      jobId: requireIdentifier(jobId, "jobId"),
      attachmentId,
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
  if (Object.keys(source).some((key) => key !== "attachmentId")) {
    throw new OpenMontageArtifactValidationError("Artifact grant request has unsupported fields");
  }
  return source;
}

function requireIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw new OpenMontageArtifactValidationError(`${name} is invalid`);
  }
  return value.trim();
}
