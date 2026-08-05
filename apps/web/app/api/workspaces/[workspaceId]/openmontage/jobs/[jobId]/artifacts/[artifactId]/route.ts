import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  readContentBlobSync,
  readEmployeeArtifactSync,
  readOpenMontageChatBindingSync,
  readOpenMontageJobLinkSync,
  readOpenMontageJobProjectionSync,
} from "@dofe-agent/db";
import {
  canReadChannelForActorSync,
  createAttachmentStorageClient,
} from "@dofe-agent/services";
import { getWorkspaceAccessForIdentifier } from "@/features/auth/server-workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string; jobId: string; artifactId: string }> },
): Promise<Response> {
  const { workspaceId: workspaceIdentifier, jobId, artifactId } = await context.params;
  const access = await getWorkspaceAccessForIdentifier(workspaceIdentifier);
  if (access.status === "unauthenticated") {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  if (access.status !== "ok") {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  const workspaceId = access.context.currentWorkspace.id;
  const link = readOpenMontageJobLinkSync(jobId);
  const binding = readOpenMontageChatBindingSync(workspaceId, jobId);
  if (!link || link.workspaceId !== workspaceId || !binding) {
    return new Response("Artifact not found.", { status: 404 });
  }
  const actor = {
    userId: access.context.currentUser.id,
    displayName: access.context.currentUser.displayName,
    role: access.context.currentMembership.role,
  };
  if (!canReadChannelForActorSync({ workspaceId, channelName: binding.channelName, actor })) {
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  const projection = readOpenMontageJobProjectionSync(workspaceId, jobId);
  const published = projection?.artifacts.find((value) => value.artifactId === artifactId);
  const artifact = readEmployeeArtifactSync(artifactId, workspaceId);
  if (
    !published
    || !artifact
    || artifact.deletedAt
    || artifact.employeeId !== link.employeeId
    || artifact.sourceTaskId !== link.rootTaskId
    || artifact.contentDigest !== published.sha256
  ) {
    return new Response("Artifact not found.", { status: 404 });
  }
  const blob = readContentBlobSync(artifact.contentDigest, workspaceId);
  if (!blob || blob.sizeBytes !== artifact.sizeBytes) {
    return new Response("Artifact not found.", { status: 404 });
  }

  const storage = createAttachmentStorageClient();
  const storageInput = {
    storageProvider: blob.storageProvider,
    storageBucket: blob.storageBucket,
    storageRegion: blob.storageRegion,
    storageEndpoint: blob.storageEndpoint,
    storageKey: blob.storageKey,
    storedPath: blob.storageProvider === "tos"
      ? `tos://${blob.storageBucket ?? ""}/${blob.storageKey}`
      : `local:///${blob.storageKey}`,
  };
  const signedUrl = await storage.createReadUrl(storageInput);
  if (signedUrl) {
    return new Response(null, {
      status: 307,
      headers: { "Cache-Control": "private, no-store", Location: signedUrl, Vary: "Cookie, Authorization" },
    });
  }

  let bytes: Uint8Array;
  try {
    bytes = storage.getContentAddressedBlobSync({ workspaceId, sha256: artifact.contentDigest });
  } catch {
    return new Response("Artifact not found.", { status: 404 });
  }
  if (
    bytes.byteLength !== artifact.sizeBytes
    || createHash("sha256").update(bytes).digest("hex") !== artifact.contentDigest
  ) {
    return new Response("Artifact not found.", { status: 404 });
  }

  const range = parseByteRange(request.headers.get("Range"), bytes.byteLength);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${bytes.byteLength}` } });
  }
  const body = range ? bytes.slice(range.start, range.end + 1) : bytes;
  const disposition = new URL(request.url).searchParams.get("download") === "1" ? "attachment" : "inline";
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-cache",
    "Content-Disposition": `${disposition}; filename="${safeFileName(artifact.fileName)}"`,
    "Content-Length": String(body.byteLength),
    "Content-Type": artifact.mediaType,
    ETag: `"sha256-${artifact.contentDigest}"`,
    Vary: "Cookie, Authorization",
  });
  if (range) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${bytes.byteLength}`);
  return new Response(Buffer.from(body), { status: range ? 206 : 200, headers });
}

function parseByteRange(value: string | null, size: number): { start: number; end: number } | "invalid" | null {
  if (!value) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim());
  if (!match) return "invalid";
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end >= size) {
    return "invalid";
  }
  return { start, end };
}

function safeFileName(value: string): string {
  return (basename(value.replace(/\\/g, "/")).trim() || "video.mp4")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\;\r\n]/g, "_");
}
