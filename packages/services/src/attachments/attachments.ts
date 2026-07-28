import { existsSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { type DofeAgentState, type MessageAttachment, type WorkspaceMessage } from "@dofe-agent/domain/workspace";
import { DEFAULT_WORKSPACE_ID, readUserSync, readWorkspaceMembershipSync } from "@dofe-agent/db";
import type { WorkspaceRole } from "@dofe-agent/db";
import { canReadChannelForActorSync, isWorkspaceAdminOrOwnerRole } from "../channel-access/channel-access.ts";
import { readWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";
import { createOpaqueId, sanitizeAttachmentFileName, resolveAttachmentMediaType, inferAttachmentKind, sameValue } from "../shared/helpers.ts";
import { createAttachmentStorageClient } from "./storage.ts";

type PersistWorkspaceAttachmentInput = {
  workspaceId?: string;
  fileName: string;
  mediaType?: string;
  sizeBytes: number;
  contentBytes: Uint8Array;
};

export interface DeleteChannelAttachmentResult {
  state: DofeAgentState;
  attachmentId: string;
  removedFromMessage: boolean;
  physicalFileDeleted: boolean;
  retainedBecauseReferenced: boolean;
}

export function persistWorkspaceAttachmentFromFileSync(input: {
  workspaceId?: string;
  sourcePath: string;
  fileName?: string;
  mediaType?: string;
}): MessageAttachment {
  if (!existsSync(input.sourcePath)) {
    throw new Error(`Attachment source "${input.sourcePath}" does not exist.`);
  }

  const sourceStat = statSync(input.sourcePath);
  if (!sourceStat.isFile()) {
    throw new Error(`Attachment source "${input.sourcePath}" is not a file.`);
  }

  return persistWorkspaceAttachmentFromBytesSync({
    workspaceId: input.workspaceId,
    contentBytes: readFileSync(input.sourcePath),
    fileName: input.fileName?.trim() || basename(input.sourcePath),
    mediaType: input.mediaType,
  });
}

export function persistWorkspaceAttachmentFromBytesSync(input: {
  workspaceId?: string;
  contentBytes: Uint8Array;
  fileName: string;
  mediaType?: string;
}): MessageAttachment {
  const contentBytes = input.contentBytes;
  const sizeBytes = contentBytes.byteLength;
  if (sizeBytes <= 0) {
    throw new Error("Attachment content cannot be empty.");
  }

  return persistWorkspaceAttachmentSync({
    workspaceId: input.workspaceId,
    fileName: input.fileName,
    mediaType: input.mediaType,
    sizeBytes,
    contentBytes,
  });
}

export function deleteWorkspaceAttachmentsSync(
  attachments: Array<Pick<MessageAttachment, "storedPath" | "storageProvider" | "storageBucket" | "storageRegion" | "storageEndpoint" | "storageKey">>,
): void {
  if (attachments.length === 0) {
    return;
  }
  const storage = createAttachmentStorageClient();
  for (const attachment of attachments) {
    if (!attachment.storageKey) {
      throw new Error(`Attachment object key is missing for "${attachment.storedPath}".`);
    }
    storage.deleteObjectSync({
      storageProvider: "tos",
      storageBucket: attachment.storageBucket,
      storageRegion: attachment.storageRegion,
      storageEndpoint: attachment.storageEndpoint,
      storageKey: attachment.storageKey,
      storedPath: attachment.storedPath,
    });
  }
}

export function readWorkspaceAttachmentBytesSync(
  attachment: Pick<MessageAttachment, "storedPath" | "storageBucket" | "storageRegion" | "storageEndpoint" | "storageKey">,
): Uint8Array {
  if (!attachment.storageKey) {
    throw new Error(`Attachment object key is missing for "${attachment.storedPath}".`);
  }
  return createAttachmentStorageClient().getObjectSync({
    storageProvider: "tos",
    storageBucket: attachment.storageBucket,
    storageRegion: attachment.storageRegion,
    storageEndpoint: attachment.storageEndpoint,
    storageKey: attachment.storageKey,
    storedPath: attachment.storedPath,
  });
}

export function deleteChannelAttachmentSync(input: {
  workspaceId?: string;
  channelName: string;
  attachmentId: string;
  actorUserId: string;
  actorDisplayName: string;
}): DeleteChannelAttachmentResult {
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const channelName = input.channelName.trim();
  const attachmentId = input.attachmentId.trim();
  const actorUserId = input.actorUserId.trim();
  const actorDisplayName = input.actorDisplayName.trim();

  if (!channelName) {
    throw new Error("Missing channel name.");
  }
  if (!attachmentId) {
    throw new Error("Missing attachment id.");
  }
  if (!actorUserId) {
    throw new Error("Forbidden.");
  }

  const membership = readWorkspaceMembershipSync(workspaceId, actorUserId);
  if (!membership) {
    throw new Error("Forbidden.");
  }
  if (
    !canReadChannelForActorSync({
      workspaceId,
      channelName,
      actor: {
        userId: actorUserId,
        displayName: actorDisplayName,
        role: membership.role,
      },
    })
  ) {
    throw new Error("Forbidden.");
  }

  const state = readWorkspaceStateSync(workspaceId);
  const match = findChannelAttachment(state, channelName, attachmentId);
  if (!match) {
    throw new Error(`Attachment "${attachmentId}" does not exist in channel "${channelName}".`);
  }
  if (match.attachment.deletedAt) {
    throw new Error(`Attachment "${attachmentId}" has already been deleted.`);
  }

  const canDelete = canActorDeleteAttachment({
    message: match.message,
    actorUserId,
    actorDisplayName,
    actorRole: membership.role,
  });
  if (!canDelete) {
    throw new Error("Forbidden.");
  }

  const deletedAt = new Date().toISOString();
  const updatedAttachment: MessageAttachment = {
    ...match.attachment,
    deletedAt,
    deletedByUserId: actorUserId,
    deletedByDisplayName: actorDisplayName || readUserSync(actorUserId)?.displayName,
  };
  state.messages = state.messages.map((message) => {
    if (message.id !== match.message.id) {
      return message;
    }
    return {
      ...message,
      attachments: (message.attachments ?? []).map((attachment) =>
        attachment.id === attachmentId ? updatedAttachment : attachment,
      ),
    };
  });
  state.ledger.unshift({
    title: "Channel file deleted",
    note: `${actorDisplayName || actorUserId} deleted "${match.attachment.fileName}" from ${channelName}.`,
    code: "channel_file.deleted",
    data: {
      channel_name: channelName,
      attachment_id: attachmentId,
      source_message_id: match.message.id,
      actor_user_id: actorUserId,
    },
  });

  const nextState = writeWorkspaceStateSync(state, workspaceId);
  const retainedBecauseReferenced = isAttachmentStillReferenced(nextState, match.attachment);
  if (!retainedBecauseReferenced) {
    deleteWorkspaceAttachmentsSync([match.attachment]);
  }

  return {
    state: nextState,
    attachmentId,
    removedFromMessage: true,
    physicalFileDeleted: !retainedBecauseReferenced,
    retainedBecauseReferenced,
  };
}

export function deleteUnreferencedWorkspaceAttachmentsSync(
  attachments: MessageAttachment[],
  state: DofeAgentState,
): number {
  const unreferenced = attachments.filter((attachment) => !isAttachmentStillReferenced(state, attachment));
  deleteWorkspaceAttachmentsSync(unreferenced);
  return unreferenced.length;
}

function persistWorkspaceAttachmentSync(input: PersistWorkspaceAttachmentInput): MessageAttachment {
  const id = `att-${createOpaqueId()}`;
  const workspaceId = input.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const fileName = normalizeAttachmentDisplayName(input.fileName);
  const mediaType = resolveAttachmentMediaType(fileName, input.mediaType);
  const storedFileName = basename(sanitizeAttachmentFileName(fileName));

  const storage = createAttachmentStorageClient();
  const stored = storage.putObjectSync({
    workspaceId,
    attachmentId: id,
    fileName: storedFileName,
    contentBytes: input.contentBytes,
    mediaType,
  });

  return {
    id,
    fileName,
    mediaType,
    sizeBytes: input.sizeBytes,
    kind: inferAttachmentKind(mediaType),
    storedPath: stored.storedPath,
    storageProvider: stored.provider,
    storageBucket: stored.bucket,
    storageRegion: stored.region,
    storageEndpoint: stored.endpoint,
    storageKey: stored.key,
    storageUrl: stored.url,
    sha256: stored.sha256,
  };
}

function normalizeAttachmentDisplayName(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");

  return normalized || "attachment.bin";
}

function findChannelAttachment(
  state: DofeAgentState,
  channelName: string,
  attachmentId: string,
): { attachment: MessageAttachment; message: WorkspaceMessage } | null {
  for (const message of state.messages) {
    if (!sameValue(message.channel ?? "", channelName)) {
      continue;
    }
    const attachment = message.attachments?.find((item) => item.id === attachmentId);
    if (attachment) {
      return { attachment, message };
    }
  }
  return null;
}

function canActorDeleteAttachment(input: {
  message: WorkspaceMessage;
  actorUserId: string;
  actorDisplayName: string;
  actorRole: WorkspaceRole;
}): boolean {
  if (isWorkspaceAdminOrOwnerRole(input.actorRole)) {
    return true;
  }
  if (input.message.role !== "human") {
    return false;
  }
  if (input.message.speakerUserId) {
    return input.message.speakerUserId === input.actorUserId;
  }
  const actorDisplayName = input.actorDisplayName || readUserSync(input.actorUserId)?.displayName || "";
  return Boolean(actorDisplayName) && sameValue(input.message.speaker, actorDisplayName);
}

function isAttachmentStillReferenced(state: DofeAgentState, deletedAttachment: MessageAttachment): boolean {
  const deletedPath = deletedAttachment.storedPath;

  for (const message of state.messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.deletedAt) {
        continue;
      }
      if (attachment.id === deletedAttachment.id || attachment.storedPath === deletedPath) {
        return true;
      }
    }
  }

  for (const page of state.knowledgePages) {
    if (
      page.sourceAttachmentId === deletedAttachment.id ||
      page.sourceAttachmentStoredPath === deletedPath
    ) {
      return true;
    }
  }

  for (const version of state.channelDocumentVersions) {
    if (
      version.sourceAttachmentId === deletedAttachment.id ||
      version.sourceAttachmentStoredPath === deletedPath
    ) {
      return true;
    }
  }

  return false;
}
