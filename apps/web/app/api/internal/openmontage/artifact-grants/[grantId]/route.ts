import { basename } from "node:path";
import { Readable } from "node:stream";
import { OpenMontageArtifactGrantError } from "@dofe-agent/db";
import {
  OpenMontageArtifactAuthenticationError,
  OpenMontageArtifactConfigurationError,
  OpenMontageArtifactValidationError,
  publishOpenMontageArtifactUpload,
  resolveOpenMontageArtifactReadDownload,
} from "@dofe-agent/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ grantId: string }> },
): Promise<Response> {
  try {
    const { grantId } = await context.params;
    const result = await resolveOpenMontageArtifactReadDownload({
      grantId: requireGrantId(grantId),
      headers: request.headers,
    });
    const headers = artifactHeaders(result.attachment);
    if (result.kind === "redirect") {
      headers.set("Location", result.url);
      return new Response(null, { status: 307, headers });
    }
    headers.set("Content-Length", String(result.bytes.byteLength));
    return new Response(Buffer.from(result.bytes), { status: 200, headers });
  } catch (error) {
    if (
      error instanceof OpenMontageArtifactAuthenticationError
      || error instanceof OpenMontageArtifactGrantError
    ) {
      return Response.json(
        { error: { code: "OPENMONTAGE_ARTIFACT_GRANT_INVALID" } },
        { status: 401, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    if (error instanceof OpenMontageArtifactValidationError) {
      return Response.json(
        { error: { code: "OPENMONTAGE_ARTIFACT_INTEGRITY_FAILED" } },
        { status: 409, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    throw error;
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ grantId: string }> },
): Promise<Response> {
  try {
    if (!request.body) {
      throw new OpenMontageArtifactValidationError("OpenMontage artifact upload body is required");
    }
    const { grantId } = await context.params;
    const artifact = await publishOpenMontageArtifactUpload({
      grantId: requireGrantId(grantId),
      headers: request.headers,
      content: Readable.fromWeb(request.body as never),
    });
    return Response.json(artifact, {
      status: 201,
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (
      error instanceof OpenMontageArtifactAuthenticationError
      || error instanceof OpenMontageArtifactGrantError
    ) {
      return Response.json(
        { error: { code: "OPENMONTAGE_ARTIFACT_GRANT_INVALID" } },
        { status: 401, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    if (error instanceof OpenMontageArtifactConfigurationError) {
      return Response.json(
        { error: { code: "OPENMONTAGE_ARTIFACT_BRIDGE_NOT_CONFIGURED" } },
        { status: 503, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    if (error instanceof OpenMontageArtifactValidationError) {
      return Response.json(
        { error: { code: "OPENMONTAGE_ARTIFACT_INTEGRITY_FAILED" } },
        { status: 409, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    throw error;
  }
}

function artifactHeaders(attachment: {
  fileName: string;
  mediaType: string;
  sizeBytes: number;
  sha256?: string;
}): Headers {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Disposition": buildContentDisposition(attachment.fileName),
    "Content-Type": attachment.mediaType || "application/octet-stream",
    "X-Content-SHA256": attachment.sha256 ?? "",
    "X-Content-Length": String(attachment.sizeBytes),
  });
  return headers;
}

function buildContentDisposition(fileName: string): string {
  const normalized = basename(fileName.replace(/\\/g, "/")).trim() || "artifact.bin";
  const fallback = normalized.replace(/[^\x20-\x7E]/g, "_").replace(/["\\;\r\n]/g, "_");
  return fallback === normalized
    ? `attachment; filename="${fallback}"`
    : `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(normalized)}`;
}

function requireGrantId(value: string): string {
  const normalized = value.trim();
  if (!/^om_ag_[A-Za-z0-9_-]{1,256}$/.test(normalized)) {
    throw new OpenMontageArtifactAuthenticationError("Artifact grant is invalid");
  }
  return normalized;
}
