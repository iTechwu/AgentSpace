import type {
  DofeAgentState,
  ChannelDocument,
  ChannelDocumentEditorType,
  ChannelDocumentExternalProvider,
  ChannelDocumentJsonContent,
  ChannelDocumentKind,
  ChannelDocumentStorageMode,
  ChannelDocumentTriggerType,
  ChannelDocumentVersion,
} from "@dofe-agent/domain/workspace";
import {
  buildChannelDocumentRecord,
  buildChannelDocumentVersionRecord,
  ensureUniqueChannelDocumentSlug,
  sortChannelDocuments,
  summarizeChannelDocument,
} from "./model.ts";

export function listChannelDocuments(
  state: DofeAgentState,
  channelName?: string,
): ChannelDocument[] {
  const documents = channelName
    ? state.channelDocuments.filter((document) => sameValue(document.channelName, channelName))
    : state.channelDocuments;

  return sortChannelDocuments(documents);
}

export function listChannelDocumentVersions(
  state: DofeAgentState,
  documentId: string,
): ChannelDocumentVersion[] {
  return state.channelDocumentVersions
    .filter((version) => version.documentId === documentId)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function readChannelDocument(
  state: DofeAgentState,
  documentId: string,
): {
  document: ChannelDocument;
  currentVersion: ChannelDocumentVersion;
  versions: ChannelDocumentVersion[];
} {
  const document = state.channelDocuments.find((item) => item.id === documentId);
  if (!document) {
    throw new Error(`Channel document "${documentId}" does not exist.`);
  }

  const versions = listChannelDocumentVersions(state, documentId);
  const currentVersion = versions.find((version) => version.id === document.currentVersionId) ?? versions[0];
  if (!currentVersion) {
    throw new Error(`Channel document "${document.title}" has no versions.`);
  }

  return { document, currentVersion, versions };
}

export function createChannelDocument(input: {
  state: DofeAgentState;
  channelName: string;
  title: string;
  kind?: ChannelDocumentKind;
  storageMode?: ChannelDocumentStorageMode;
  contentJson?: ChannelDocumentJsonContent;
  linkedTableId?: string;
  externalProvider?: ChannelDocumentExternalProvider;
  externalFileId?: string;
  externalUrl?: string;
  externalRevisionId?: string;
  contentMarkdown?: string;
  summary?: string;
  externalSyncStatus?: ChannelDocument["externalSyncStatus"];
  externalMimeType?: string;
  externalUpdatedAt?: string;
  createdBy: string;
  createdByType: ChannelDocumentEditorType;
  triggerType?: ChannelDocumentTriggerType;
  sourceMessageId?: string;
  sourceAttachmentId?: string;
  sourceAttachmentStoredPath?: string;
  sourceTaskQueueId?: string;
}): { state: DofeAgentState; document: ChannelDocument; version: ChannelDocumentVersion } {
  const { state } = input;
  if (!state.channels.some((channel) => sameValue(channel.name, input.channelName))) {
    throw new Error(`Channel "${input.channelName}" does not exist.`);
  }

  const title = input.title.trim();
  if (!title) {
    throw new Error("Document title is required.");
  }
  if (
    state.channelDocuments.some(
      (document) =>
        sameValue(document.channelName, input.channelName) &&
        sameValue(document.title, title) &&
        document.status === "active",
    )
  ) {
    throw new Error(`Channel document "${title}" already exists in ${input.channelName}.`);
  }

  const now = new Date().toISOString();
  const contentMarkdown = input.contentMarkdown ?? "";
  const summary = summarizeChannelDocument(contentMarkdown, input.summary);
  const documentId = `channel-doc-${createOpaqueId()}`;
  const versionId = `channel-doc-version-${createOpaqueId()}`;
  const document = buildChannelDocumentRecord({
    id: documentId,
    channelName: input.channelName,
    title,
    kind: input.kind,
    storageMode: input.storageMode,
    linkedTableId: input.linkedTableId,
    externalProvider: input.externalProvider,
    externalFileId: input.externalFileId,
    externalUrl: input.externalUrl,
    externalRevisionId: input.externalRevisionId,
    currentVersionId: versionId,
    summary,
    externalSyncStatus: input.externalSyncStatus,
    externalMimeType: input.externalMimeType,
    externalUpdatedAt: input.externalUpdatedAt,
    lastEditorType: input.createdByType,
    createdBy: input.createdBy.trim() || "Unknown",
    updatedBy: input.createdBy.trim() || "Unknown",
    createdAt: now,
    updatedAt: now,
    existingDocuments: state.channelDocuments,
  });
  const version = buildChannelDocumentVersionRecord({
    id: versionId,
    documentId,
    contentMarkdown,
    contentJson: input.contentJson,
    summary,
    createdBy: input.createdBy.trim() || "Unknown",
    createdByType: input.createdByType,
    triggerType: input.triggerType ?? "manual",
    sourceMessageId: input.sourceMessageId?.trim() || undefined,
    sourceAttachmentId: input.sourceAttachmentId?.trim() || undefined,
    sourceAttachmentStoredPath: input.sourceAttachmentStoredPath?.trim() || undefined,
    sourceTaskQueueId: input.sourceTaskQueueId?.trim() || undefined,
    createdAt: now,
  });

  state.channelDocuments.unshift(document);
  state.channelDocumentVersions.unshift(version);
  return { state, document, version };
}

export function updateChannelDocument(input: {
  state: DofeAgentState;
  documentId: string;
  contentMarkdown: string;
  contentJson?: ChannelDocumentJsonContent;
  summary?: string;
  updatedBy: string;
  updatedByType: ChannelDocumentEditorType;
  triggerType?: ChannelDocumentTriggerType;
  sourceMessageId?: string;
  sourceAttachmentId?: string;
  sourceAttachmentStoredPath?: string;
  sourceTaskQueueId?: string;
}): { state: DofeAgentState; document: ChannelDocument; version: ChannelDocumentVersion } {
  const { state } = input;
  const document = state.channelDocuments.find((item) => item.id === input.documentId);
  if (!document) {
    throw new Error(`Channel document "${input.documentId}" does not exist.`);
  }

  const now = new Date().toISOString();
  const summary = summarizeChannelDocument(input.contentMarkdown, input.summary);
  const version = buildChannelDocumentVersionRecord({
    id: `channel-doc-version-${createOpaqueId()}`,
    documentId: document.id,
    contentMarkdown: input.contentMarkdown,
    contentJson: input.contentJson,
    summary,
    createdBy: input.updatedBy.trim() || "Unknown",
    createdByType: input.updatedByType,
    triggerType: input.triggerType ?? "manual",
    sourceMessageId: input.sourceMessageId?.trim() || undefined,
    sourceAttachmentId: input.sourceAttachmentId?.trim() || undefined,
    sourceAttachmentStoredPath: input.sourceAttachmentStoredPath?.trim() || undefined,
    sourceTaskQueueId: input.sourceTaskQueueId?.trim() || undefined,
    createdAt: now,
  });

  document.currentVersionId = version.id;
  document.summary = summary;
  document.lastEditorType = input.updatedByType;
  document.updatedBy = input.updatedBy.trim() || "Unknown";
  document.updatedAt = now;
  state.channelDocumentVersions.unshift(version);
  return { state, document, version };
}

export function renameChannelDocument(input: {
  state: DofeAgentState;
  documentId: string;
  nextTitle: string;
}): { state: DofeAgentState; document: ChannelDocument; previousTitle: string } {
  const { state } = input;
  const document = state.channelDocuments.find((item) => item.id === input.documentId);
  if (!document) {
    throw new Error(`Channel document "${input.documentId}" does not exist.`);
  }

  const title = input.nextTitle.trim();
  if (!title) {
    throw new Error("Document title is required.");
  }
  if (
    state.channelDocuments.some(
      (item) =>
        item.id !== document.id &&
        sameValue(item.channelName, document.channelName) &&
        sameValue(item.title, title) &&
        item.status === "active",
    )
  ) {
    throw new Error(`Channel document "${title}" already exists in ${document.channelName}.`);
  }

  const previousTitle = document.title;
  document.title = title;
  document.slug = ensureUniqueChannelDocumentSlug(state.channelDocuments, document.channelName, title, document.id);
  document.updatedAt = new Date().toISOString();
  return { state, document, previousTitle };
}

export function archiveChannelDocument(input: {
  state: DofeAgentState;
  documentId: string;
}): { state: DofeAgentState; document: ChannelDocument } {
  const { state } = input;
  const document = state.channelDocuments.find((item) => item.id === input.documentId);
  if (!document) {
    throw new Error(`Channel document "${input.documentId}" does not exist.`);
  }

  document.status = "archived";
  document.updatedAt = new Date().toISOString();
  return { state, document };
}

export function restoreChannelDocument(input: {
  state: DofeAgentState;
  documentId: string;
}): { state: DofeAgentState; document: ChannelDocument } {
  const { state } = input;
  const document = state.channelDocuments.find((item) => item.id === input.documentId);
  if (!document) {
    throw new Error(`Channel document "${input.documentId}" does not exist.`);
  }
  if (document.status === "active") {
    return { state, document };
  }
  if (
    state.channelDocuments.some(
      (item) =>
        item.id !== document.id &&
        sameValue(item.channelName, document.channelName) &&
        sameValue(item.title, document.title) &&
        item.status === "active",
    )
  ) {
    throw new Error(`Channel document "${document.title}" already exists in ${document.channelName}. Rename the active document before restoring this one.`);
  }

  document.status = "active";
  document.updatedAt = new Date().toISOString();
  return { state, document };
}

export function rollbackChannelDocumentVersion(input: {
  state: DofeAgentState;
  documentId: string;
  versionId: string;
  updatedBy: string;
  updatedByType: ChannelDocumentEditorType;
}): { state: DofeAgentState; document: ChannelDocument; version: ChannelDocumentVersion } {
  const { state } = input;
  const { document } = readChannelDocument(state, input.documentId);
  const versionToRestore = listChannelDocumentVersions(state, input.documentId).find((version) => version.id === input.versionId);
  if (!versionToRestore) {
    throw new Error(`Document version "${input.versionId}" does not exist.`);
  }

  return updateChannelDocument({
    state,
    documentId: document.id,
    contentMarkdown: versionToRestore.contentMarkdown,
    contentJson: versionToRestore.contentJson,
    summary: versionToRestore.summary,
    updatedBy: input.updatedBy,
    updatedByType: input.updatedByType,
    triggerType: "manual",
  });
}

function sameValue(left: string, right: string): boolean {
  return left.localeCompare(right, "zh-CN", { sensitivity: "base" }) === 0;
}

function createOpaqueId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
