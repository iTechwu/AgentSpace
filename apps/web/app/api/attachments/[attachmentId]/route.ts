import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename } from "node:path";
import type { MessageAttachment } from "@dofe-agent/domain/workspace";
import {
  canViewChannelDocumentSync,
  createAttachmentStorageClient,
  inferAttachmentKind,
  readStoredAttachmentSync,
  readWorkspaceStateSync,
  resolveAttachmentMediaType,
  tryRecordWorkspaceAuditEventSync,
} from "@dofe-agent/services";
import { getCurrentWorkspaceContext } from "@/features/auth/server-workspace";
import { getWorkspaceChannelVisibilitySync } from "@/features/auth/workspace-channel-visibility";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IMAGE_ATTACHMENT_CACHE_CONTROL = "private, max-age=3600, stale-while-revalidate=86400";
const FILE_ATTACHMENT_CACHE_CONTROL = "private, no-cache";
const ATTACHMENT_VARY_HEADER = "Cookie, Authorization";

export async function GET(
  request: Request,
  context: { params: Promise<{ attachmentId: string }> },
): Promise<Response> {
  const workspaceContext = await getCurrentWorkspaceContext();
  if (!workspaceContext) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { attachmentId } = await context.params;
  const requestedWorkspaceId = new URL(request.url).searchParams.get("workspaceId")?.trim() || undefined;
  if (requestedWorkspaceId && requestedWorkspaceId !== workspaceContext.currentWorkspace.id) {
    tryRecordWorkspaceAuditEventSync({
      workspaceId: workspaceContext.currentWorkspace.id,
      title: "Cross-workspace attachment access denied",
      note:
        `Attachment "${attachmentId}" was requested with workspace "${requestedWorkspaceId}" `
        + `while the current workspace is "${workspaceContext.currentWorkspace.id}".`,
      code: "workspace.cross_workspace_access_denied",
      data: {
        actorType: "session_user",
        resourceType: "attachment",
        resourceId: attachmentId,
        requestedWorkspaceId,
      },
    });
    return Response.json({ error: "Forbidden." }, { status: 403 });
  }

  let visibility: ReturnType<typeof getWorkspaceChannelVisibilitySync> | null = null;
  const getVisibility = () => {
    visibility ??= getWorkspaceChannelVisibilitySync(
      workspaceContext.currentWorkspace.id,
      workspaceContext.currentUser.displayName,
      {
        userId: workspaceContext.currentUser.id,
        displayName: workspaceContext.currentUser.displayName,
        role: workspaceContext.currentMembership.role,
      },
    );
    return visibility;
  };
  const storedAttachment = readStoredAttachmentSync(workspaceContext.currentWorkspace.id, attachmentId);
  const attachment: MessageAttachment | null = storedAttachment
    ? (
        canReadStoredAttachmentWithoutVisibility({
          attachment: storedAttachment,
          workspaceId: workspaceContext.currentWorkspace.id,
          workspaceRole: workspaceContext.currentMembership.role,
        }) || getVisibility().canAccessChannel(storedAttachment.channelName)
          ? storedAttachment
          : null
      )
    : shouldUseLegacyAttachmentFallback()
      ? findAttachment(
        attachmentId,
        workspaceContext.currentWorkspace.id,
        workspaceContext.currentUser.displayName,
        getVisibility(),
      )
      : null;

  if (!attachment) {
    return new Response("Attachment not found.", { status: 404 });
  }

  const mediaType = resolveAttachmentMediaType(attachment.fileName, attachment.mediaType);
  const kind = inferAttachmentKind(mediaType);
  const disposition = kind === "image" ? "inline" : "attachment";
  const contentDisposition = buildContentDisposition(disposition, attachment.fileName);
  const cacheControl = resolveAttachmentCacheControl(kind);
  const requestEntityTags = request.headers.get("If-None-Match");
  const metadataEntityTag = buildAttachmentEntityTag(attachment.sha256);

  if (metadataEntityTag && requestEntityTagsMatch(requestEntityTags, metadataEntityTag)) {
    return new Response(null, {
      status: 304,
      headers: buildAttachmentResponseHeaders({
        cacheControl,
        contentDisposition,
        entityTag: metadataEntityTag,
        mediaType,
      }),
    });
  }

  let content: Uint8Array;
  try {
    content = await readAttachmentContent(attachment);
  } catch (error) {
    if (error instanceof AttachmentNotFoundError || isStorageMissingError(error)) {
      const note = error instanceof Error ? error.message : "Attachment object is missing from storage.";
      tryRecordWorkspaceAuditEventSync({
        workspaceId: workspaceContext.currentWorkspace.id,
        title: "Attachment storage object missing",
        note,
        code: "attachment.storage_missing",
        data: {
          actorType: "session_user",
          resourceType: "attachment",
          resourceId: attachment.id,
        },
      });
      return new Response("Attachment not found.", { status: 404 });
    }
    throw error;
  }
  const entityTag = metadataEntityTag ?? buildAttachmentEntityTag(sha256Hex(content));

  if (entityTag && requestEntityTagsMatch(requestEntityTags, entityTag)) {
    return new Response(null, {
      status: 304,
      headers: buildAttachmentResponseHeaders({
        cacheControl,
        contentDisposition,
        entityTag,
        mediaType,
      }),
    });
  }

  return new Response(Buffer.from(content), {
    headers: buildAttachmentResponseHeaders({
      cacheControl,
      contentDisposition,
      contentLength: content.byteLength,
      entityTag,
      mediaType,
    }),
  });
}

async function readAttachmentContent(attachment: MessageAttachment): Promise<Uint8Array> {
  if ((attachment.storageProvider === "tos" || attachment.storageProvider === "s3") && attachment.storageKey) {
    return createAttachmentStorageClient().getObject({
      storageProvider: attachment.storageProvider,
      storageBucket: attachment.storageBucket,
      storageRegion: attachment.storageRegion,
      storageEndpoint: attachment.storageEndpoint,
      storageKey: attachment.storageKey,
      storedPath: attachment.storedPath,
    });
  }

  try {
    await access(attachment.storedPath, constants.R_OK);
  } catch {
    throw new AttachmentNotFoundError(attachment.id, attachment.storedPath);
  }
  return readFile(attachment.storedPath);
}

function buildContentDisposition(disposition: "inline" | "attachment", fileName: string): string {
  const normalizedName = basename(fileName.replace(/\\/g, "/")).trim() || "download";
  const asciiFallback = normalizedName
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\;\r\n]/g, "_")
    || "download";

  if (asciiFallback === normalizedName) {
    return `${disposition}; filename="${asciiFallback}"`;
  }

  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeHeaderParameter(normalizedName)}`;
}

function buildAttachmentResponseHeaders(input: {
  cacheControl: string;
  contentDisposition: string;
  contentLength?: number;
  entityTag?: string | null;
  mediaType: string;
}): Headers {
  const headers = new Headers({
    "Cache-Control": input.cacheControl,
    "Content-Disposition": input.contentDisposition,
    "Content-Type": input.mediaType,
    "Vary": ATTACHMENT_VARY_HEADER,
  });

  if (input.contentLength !== undefined) {
    headers.set("Content-Length", String(input.contentLength));
  }
  if (input.entityTag) {
    headers.set("ETag", input.entityTag);
  }

  return headers;
}

function resolveAttachmentCacheControl(kind: MessageAttachment["kind"]): string {
  if (kind === "image") {
    return IMAGE_ATTACHMENT_CACHE_CONTROL;
  }
  return FILE_ATTACHMENT_CACHE_CONTROL;
}

function buildAttachmentEntityTag(hash: string | undefined): string | null {
  const normalizedHash = hash?.trim();
  if (!normalizedHash || !/^[A-Za-z0-9._~:-]+$/.test(normalizedHash)) {
    return null;
  }
  return `"sha256-${normalizedHash}"`;
}

function requestEntityTagsMatch(headerValue: string | null, entityTag: string): boolean {
  if (!headerValue) {
    return false;
  }

  const normalizedEntityTag = stripWeakEntityTag(entityTag);
  return headerValue
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || stripWeakEntityTag(candidate) === normalizedEntityTag);
}

function stripWeakEntityTag(entityTag: string): string {
  return entityTag.startsWith("W/") ? entityTag.slice(2) : entityTag;
}

function sha256Hex(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function encodeHeaderParameter(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function findAttachment(
  attachmentId: string,
  workspaceId: string,
  currentUserDisplayName: string,
  visibility: ReturnType<typeof getWorkspaceChannelVisibilitySync>,
) {
  const state = readWorkspaceStateSync(workspaceId);

  for (const message of state.messages) {
    if (!visibility.canAccessChannel(message.channel)) {
      continue;
    }
    const attachment = message.attachments?.find((item) => item.id === attachmentId);
    if (attachment) {
      return attachment;
    }
  }

  const knowledgeAttachment = state.knowledgePages.find((page) => page.sourceAttachmentId === attachmentId);
  if (knowledgeAttachment?.sourceAttachmentStoredPath) {
    const sourceMessage = state.messages.find((message) =>
      message.attachments?.some((attachment) => attachment.id === attachmentId)
    );
    if (sourceMessage && !visibility.canAccessChannel(sourceMessage.channel)) {
      return null;
    }
    return buildSnapshotAttachment(attachmentId, knowledgeAttachment.sourceAttachmentStoredPath);
  }

  for (const version of state.channelDocumentVersions) {
    if (version.sourceAttachmentId !== attachmentId || !version.sourceAttachmentStoredPath) {
      continue;
    }
    if (!canViewChannelDocumentSync(version.documentId, currentUserDisplayName, "human", workspaceId)) {
      continue;
    }
    return buildSnapshotAttachment(attachmentId, version.sourceAttachmentStoredPath);
  }

  return null;
}

function shouldUseLegacyAttachmentFallback(): boolean {
  const configured = process.env.DOFE_AGENT_ATTACHMENT_LEGACY_FALLBACK_ENABLED?.trim().toLowerCase();
  if (configured) {
    return configured !== "0" && configured !== "false";
  }
  return process.env.LOADTEST_MODE !== "local";
}

function canReadStoredAttachmentWithoutVisibility(input: {
  attachment: { channelName?: string | null };
  workspaceId: string;
  workspaceRole?: string;
}): boolean {
  const channelName = input.attachment.channelName?.trim();
  if (!channelName) {
    return true;
  }
  if (process.env.LOADTEST_MODE !== "local") {
    return false;
  }
  if (!input.workspaceId.startsWith("loadtest-")) {
    return false;
  }
  if (!["owner", "admin", "member"].includes(input.workspaceRole ?? "")) {
    return false;
  }
  return channelName.startsWith("load-channel-");
}

function buildSnapshotAttachment(attachmentId: string, storedPath: string) {
  const fallbackName = basename(storedPath.replace(/\\/g, "/")).replace(new RegExp(`^${escapeRegExp(attachmentId)}-`), "");
  const fileName = fallbackName || `${attachmentId}.bin`;
  const mediaType = resolveAttachmentMediaType(fileName);
  return {
    id: attachmentId,
    fileName,
    mediaType,
    sizeBytes: 0,
    kind: inferAttachmentKind(mediaType),
    storedPath,
  } satisfies MessageAttachment;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class AttachmentNotFoundError extends Error {
  constructor(attachmentId: string, storedPath: string) {
    super(`Attachment "${attachmentId}" is missing from storage: ${storedPath}`);
    this.name = "AttachmentNotFoundError";
  }
}

function isStorageMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /TOS read failed with status 404|NoSuchKey|NoSuchBucket/i.test(error.message);
}
