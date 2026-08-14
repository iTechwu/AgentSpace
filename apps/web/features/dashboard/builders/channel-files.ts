// 频道附件（文件）域 helper：附件引用索引（知识页/文档版本引用判定）、
// 删除权限元数据、markdown 预览读取与存储文件名还原。
// readMarkdownAttachmentPreviewText 会读附件存储（readWorkspaceAttachmentBytesSync）。
import { basename } from "node:path";
import {
  inferAttachmentKind,
  readWorkspaceAttachmentBytesSync,
  resolveAttachmentMediaType,
} from "@dofe-agent/services";
import type {
  WorkspaceRole,
} from "@dofe-agent/db";
import type {
  DofeAgentState,
  MessageAttachment,
  WorkspaceMessage,
} from "@dofe-agent/domain/workspace";
import type {
  ChannelFileRecord,
} from "../data-types";
import { isWorkspaceManagerRole } from "./workspace-members";
import { sameText } from "./text";

export function buildChannelFileDeleteMetadata(input: {
  state: DofeAgentState;
  message: WorkspaceMessage;
  attachment: MessageAttachment;
  attachmentReferenceIndex?: AttachmentReferenceIndex;
  currentUserDisplayName?: string;
  currentUserId?: string;
  currentMembershipRole?: WorkspaceRole;
}): Pick<ChannelFileRecord, "canDelete" | "deleteBlockedReason" | "retainedBecauseReferenced"> {
  const retainedBecauseReferenced = isAttachmentReferencedByKnowledgeOrDocument(
    input.state,
    input.attachment,
    input.attachmentReferenceIndex,
  );
  if (!input.currentUserId) {
    return {
      canDelete: false,
      deleteBlockedReason: "Sign in to delete this file.",
      retainedBecauseReferenced,
    };
  }
  if (isWorkspaceManagerRole(input.currentMembershipRole)) {
    return { canDelete: true, retainedBecauseReferenced };
  }
  if (input.message.role !== "human") {
    return {
      canDelete: false,
      deleteBlockedReason: "Only workspace admins can delete agent output files.",
      retainedBecauseReferenced,
    };
  }
  if (input.message.speakerUserId) {
    if (input.message.speakerUserId === input.currentUserId) {
      return { canDelete: true, retainedBecauseReferenced };
    }
    return {
      canDelete: false,
      deleteBlockedReason: "Only the uploader or a workspace admin can delete this file.",
      retainedBecauseReferenced,
    };
  }
  if (input.currentUserDisplayName?.trim() && sameText(input.message.speaker, input.currentUserDisplayName)) {
    return { canDelete: true, retainedBecauseReferenced };
  }
  return {
    canDelete: false,
    deleteBlockedReason: "Only the uploader or a workspace admin can delete this file.",
    retainedBecauseReferenced,
  };
}

export interface AttachmentReferenceIndex {
  ids: Set<string>;
  storedPaths: Set<string>;
}

export function buildAttachmentReferenceIndex(state: DofeAgentState): AttachmentReferenceIndex {
  const ids = new Set<string>();
  const storedPaths = new Set<string>();

  for (const page of state.knowledgePages ?? []) {
    if (page.sourceAttachmentId) {
      ids.add(page.sourceAttachmentId);
    }
    if (page.sourceAttachmentStoredPath) {
      storedPaths.add(page.sourceAttachmentStoredPath);
    }
  }

  for (const version of state.channelDocumentVersions ?? []) {
    if (version.sourceAttachmentId) {
      ids.add(version.sourceAttachmentId);
    }
    if (version.sourceAttachmentStoredPath) {
      storedPaths.add(version.sourceAttachmentStoredPath);
    }
  }

  return { ids, storedPaths };
}

export function isAttachmentReferencedByKnowledgeOrDocument(
  state: DofeAgentState,
  attachment: MessageAttachment,
  referenceIndex = buildAttachmentReferenceIndex(state),
): boolean {
  return referenceIndex.ids.has(attachment.id) || referenceIndex.storedPaths.has(attachment.storedPath);
}

export function deriveAttachmentFileName(attachmentId: string, storedPath: string): string {
  const storedName = basename(storedPath.replace(/\\/g, "/"));
  const prefix = `${attachmentId}-`;
  return storedName.startsWith(prefix) ? storedName.slice(prefix.length) : storedName;
}

export function readMarkdownAttachmentPreviewText(attachment: MessageAttachment): string {
  try {
    return Buffer.from(readWorkspaceAttachmentBytesSync(attachment)).toString("utf8").trim();
  } catch {
    return "";
  }
}
