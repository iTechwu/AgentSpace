// 知识域视图构建：把频道文档、频道附件与知识页统一装配为知识文档页记录
// （含被知识页/文档版本保留的合成附件记录）。
import {
  inferAttachmentKind,
  resolveAttachmentMediaType,
} from "@dofe-agent/services";
import type {
  KnowledgePage,
} from "@dofe-agent/domain/workspace";
import type {
  ChannelDocumentRecord,
  ChannelFileRecord,
  KnowledgeDocumentPageRecord,
} from "../data-types";
import { deriveAttachmentFileName } from "./channel-files";

export function buildKnowledgeDocumentPageRecords(
  documents: ChannelDocumentRecord[],
  channelFiles: ChannelFileRecord[],
  knowledgePages: KnowledgePage[],
): KnowledgeDocumentPageRecord[] {
  const linkIndex = new Map<string, KnowledgeDocumentPageRecord["linkedKnowledgePages"]>();
  const linkedChannelDocumentIndex = new Map<string, KnowledgeDocumentPageRecord["linkedChannelDocuments"]>();

  for (const page of knowledgePages) {
    const link = { id: page.id, title: page.title };
    if (page.sourceAttachmentId) {
      const key = `attachment:${page.sourceAttachmentId}`;
      const existing = linkIndex.get(key) ?? [];
      existing.push(link);
      linkIndex.set(key, existing);
    }
    if (page.sourceChannelDocumentId) {
      const key = `channelDocument:${page.sourceChannelDocumentId}`;
      const existing = linkIndex.get(key) ?? [];
      existing.push(link);
      linkIndex.set(key, existing);
    }
  }

  for (const document of documents) {
    const attachmentIds = new Set(
      document.versions
        .map((version) => version.sourceAttachmentId)
        .filter((attachmentId): attachmentId is string => typeof attachmentId === "string" && attachmentId.length > 0),
    );

    for (const attachmentId of attachmentIds) {
      const key = `attachment:${attachmentId}`;
      const existing = linkedChannelDocumentIndex.get(key) ?? [];
      existing.push({
        id: document.id,
        title: document.title,
        channelName: document.channelName,
      });
      linkedChannelDocumentIndex.set(key, existing);
    }
  }

  const documentPageMap = new Map<string, KnowledgeDocumentPageRecord>();

  for (const document of documents) {
    const fileName = `${document.slug || document.title}.md`;
    const previewText = document.contentMarkdown.trim() || document.summary.trim();
    const sourceAttachmentId = document.versions.find((version) => version.sourceAttachmentId)?.sourceAttachmentId;
    documentPageMap.set(`channelDocument:${document.id}`, {
      id: `channelDocument:${document.id}`,
      sourceType: "channelDocument",
      sourceId: document.id,
      title: document.title,
      summary: document.summary || "Shared Markdown document",
      previewText,
      fileName,
      mediaType: "text/markdown",
      sizeBytes: Buffer.byteLength(document.contentMarkdown, "utf8"),
      kind: "file",
      isMarkdown: true,
      channelName: document.channelName,
      sourceMessageId: document.versions[0]?.sourceMessageId,
      sourceSpeaker: document.updatedBy,
      sourceTime: document.updatedAt,
      updatedAt: document.updatedAt,
      updatedBy: document.updatedBy,
      status: document.status,
      sourceAttachmentId,
      linkedChannelDocuments: [],
      linkedKnowledgePages: linkIndex.get(`channelDocument:${document.id}`) ?? [],
    });
  }

  for (const file of channelFiles) {
    documentPageMap.set(`attachment:${file.id}`, {
      id: `attachment:${file.id}`,
      sourceType: "attachment",
      sourceId: file.id,
      title: file.fileName,
      summary: [file.channelName, file.sourceSpeaker, file.mediaType].filter(Boolean).join(" · ") || file.fileName,
      previewText: file.previewText ?? file.mediaType,
      fileName: file.fileName,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
      kind: file.kind,
      isMarkdown: file.isMarkdown,
      channelName: file.channelName,
      sourceMessageId: file.sourceMessageId,
      sourceSpeaker: file.sourceSpeaker,
      sourceTime: file.sourceTime,
      updatedAt: file.sourceTime ?? "",
      updatedBy: file.sourceSpeaker ?? "",
      status: "shared",
      linkedChannelDocuments: linkedChannelDocumentIndex.get(`attachment:${file.id}`) ?? [],
      linkedKnowledgePages: linkIndex.get(`attachment:${file.id}`) ?? [],
    });
  }

  for (const page of knowledgePages) {
    if (!page.sourceAttachmentId || !page.sourceAttachmentStoredPath) {
      continue;
    }

    const key = `attachment:${page.sourceAttachmentId}`;
    if (documentPageMap.has(key)) {
      continue;
    }

    documentPageMap.set(key, buildSyntheticAttachmentRecord({
      attachmentId: page.sourceAttachmentId,
      storedPath: page.sourceAttachmentStoredPath,
      contentMarkdown: page.contentMarkdown,
      updatedAt: page.updatedAt,
      updatedBy: page.createdBy,
      linkedKnowledgePages: linkIndex.get(key) ?? [],
      linkedChannelDocuments: linkedChannelDocumentIndex.get(key) ?? [],
    }));
  }

  for (const document of documents) {
    for (const version of document.versions) {
      if (!version.sourceAttachmentId || !version.sourceAttachmentStoredPath) {
        continue;
      }

      const key = `attachment:${version.sourceAttachmentId}`;
      const existing = documentPageMap.get(key);
      if (existing) {
        if (!existing.channelName) {
          existing.channelName = document.channelName;
        }
        if (!existing.sourceTime) {
          existing.sourceTime = version.createdAt;
        }
        if (!existing.updatedAt) {
          existing.updatedAt = version.createdAt;
        }
        if (!existing.updatedBy) {
          existing.updatedBy = version.createdBy;
        }
        existing.linkedChannelDocuments = dedupeLinkedChannelDocuments([
          ...existing.linkedChannelDocuments,
          ...(linkedChannelDocumentIndex.get(key) ?? []),
        ]);
        continue;
      }

      documentPageMap.set(key, buildSyntheticAttachmentRecord({
        attachmentId: version.sourceAttachmentId,
        storedPath: version.sourceAttachmentStoredPath,
        contentMarkdown: version.contentMarkdown,
        channelName: document.channelName,
        updatedAt: version.createdAt,
        updatedBy: version.createdBy,
        linkedKnowledgePages: linkIndex.get(key) ?? [],
        linkedChannelDocuments: linkedChannelDocumentIndex.get(key) ?? [],
      }));
    }
  }

  return [...documentPageMap.values()].sort((left, right) => {
    const timeDiff = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    if (Number.isFinite(timeDiff) && timeDiff !== 0) {
      return timeDiff;
    }
    return left.title.localeCompare(right.title, "zh-CN", { sensitivity: "base" });
  });
}

function buildSyntheticAttachmentRecord(input: {
  attachmentId: string;
  storedPath: string;
  contentMarkdown: string;
  channelName?: string;
  updatedAt: string;
  updatedBy: string;
  linkedKnowledgePages: KnowledgeDocumentPageRecord["linkedKnowledgePages"];
  linkedChannelDocuments: KnowledgeDocumentPageRecord["linkedChannelDocuments"];
}): KnowledgeDocumentPageRecord {
  const fileName = deriveAttachmentFileName(input.attachmentId, input.storedPath);
  const mediaType = resolveAttachmentMediaType(fileName);
  const sizeBytes = Buffer.byteLength(input.contentMarkdown, "utf8");

  return {
    id: `attachment:${input.attachmentId}`,
    sourceType: "attachment",
    sourceId: input.attachmentId,
    title: fileName,
    summary: input.channelName ? `Preserved attachment · #${input.channelName}` : "Preserved attachment",
    previewText: mediaType === "text/markdown" ? input.contentMarkdown.trim() : mediaType,
    fileName,
    mediaType,
    sizeBytes,
    kind: inferAttachmentKind(mediaType),
    isMarkdown: mediaType === "text/markdown",
    channelName: input.channelName,
    updatedAt: input.updatedAt,
    updatedBy: input.updatedBy,
    status: "shared",
    linkedChannelDocuments: dedupeLinkedChannelDocuments(input.linkedChannelDocuments),
    linkedKnowledgePages: input.linkedKnowledgePages,
  };
}

function dedupeLinkedChannelDocuments(
  documents: KnowledgeDocumentPageRecord["linkedChannelDocuments"],
): KnowledgeDocumentPageRecord["linkedChannelDocuments"] {
  return documents.filter(
    (document, index, all) =>
      all.findIndex((candidate) => candidate.id === document.id) === index,
  );
}
