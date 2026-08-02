import { createHash } from "node:crypto";
import { readWorkspaceRevisionSync, resolveStoredEmployeeIdSync } from "@dofe-agent/db";
import { createAttachmentStorageClient } from "@dofe-agent/services";
import { readTaskForDaemon, requireDaemonAuth } from "../../../../_lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ taskId: string; sha256: string }> },
): Promise<Response> {
  const auth = requireDaemonAuth(request);
  if (auth instanceof Response) return auth;

  const { taskId, sha256: rawSha256 } = await context.params;
  const task = readTaskForDaemon(taskId, auth);
  if (task instanceof Response) return task;

  const sha256 = rawSha256.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    return Response.json({ error: "Invalid workspace blob digest." }, { status: 400 });
  }
  const revisionId = new URL(request.url).searchParams.get("revisionId")?.trim() ?? "";
  const revision = revisionId ? readWorkspaceRevisionSync(revisionId, auth.workspaceId) : null;
  const taskEmployeeId = resolveStoredEmployeeIdSync(task.agentId, auth.workspaceId) ?? task.agentId;
  const entry = revision?.employeeId === taskEmployeeId && revision.status === "committed"
    ? readManifestEntry(revision.manifestJson, sha256)
    : undefined;
  if (!revision || !entry) {
    return Response.json({ error: "Blob is not referenced by the task employee's requested workspace revision." }, { status: 404 });
  }

  let bytes: Uint8Array;
  try {
    bytes = createAttachmentStorageClient().getContentAddressedBlobSync({ workspaceId: auth.workspaceId, sha256 });
  } catch {
    return Response.json({ error: "Workspace blob is unavailable." }, { status: 503 });
  }
  if (bytes.byteLength !== entry.size || createHash("sha256").update(bytes).digest("hex") !== sha256) {
    return Response.json({ error: "Workspace blob failed digest or size verification." }, { status: 503 });
  }

  const range = parseRange(request.headers.get("range"), bytes.byteLength);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.byteLength}` } });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, bytes.byteLength - 1);
  const body = bytes.slice(start, end + 1);
  return new Response(body, {
    status: range ? 206 : 200,
    headers: {
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "content-length": String(body.byteLength),
      "content-type": entry.mediaType,
      "etag": `"sha256-${sha256}"`,
      "x-content-sha256": sha256,
      ...(range ? { "content-range": `bytes ${start}-${end}/${bytes.byteLength}` } : {}),
    },
  });
}

function readManifestEntry(manifestJson: string | undefined, sha256: string): { size: number; mediaType: string } | undefined {
  if (!manifestJson) return undefined;
  try {
    const manifest = JSON.parse(manifestJson) as { files?: Array<Record<string, unknown>> };
    const file = manifest.files?.find((candidate) =>
      typeof candidate.sha256 === "string" && candidate.sha256.toLowerCase() === sha256
    );
    if (!file || !Number.isSafeInteger(file.size) || (file.size as number) < 0) return undefined;
    return {
      size: file.size as number,
      mediaType: typeof file.mediaType === "string" && file.mediaType ? file.mediaType : "application/octet-stream",
    };
  } catch {
    return undefined;
  }
}

function parseRange(value: string | null, size: number): { start: number; end: number } | "invalid" | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim());
  if (!match || size === 0) return "invalid";
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  const end = Math.min(requestedEnd, size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
    return "invalid";
  }
  return { start, end };
}
