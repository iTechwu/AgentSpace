// 知识页文档查看器：原 knowledge-page-client.tsx 文件内堆叠子组件，
// 抽出便于单元测试与代码导航；与父组件无跨文件状态依赖（所有回调由 props 传入）。
"use client";

import type { KnowledgeDocumentPageRecord } from "@/features/dashboard/data";
import { translateSystemSpeaker } from "@/features/i18n/presentation";
import { formatCompactTimestamp } from "@/shared/lib/time-format";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";
import MDEditor from "@uiw/react-md-editor";

export function DocumentPageViewer({
  document,
  isPending,
  onCreateChannelDocument,
  onOpenDocumentPage,
  onCreateKnowledgePage,
  onOpenLinkedKnowledgePage,
  workspaceId,
  tx,
}: {
  document: KnowledgeDocumentPageRecord;
  isPending: boolean;
  onCreateChannelDocument: (document: KnowledgeDocumentPageRecord) => void;
  onOpenDocumentPage: (documentId: string) => void;
  onCreateKnowledgePage: (document: KnowledgeDocumentPageRecord) => void;
  onOpenLinkedKnowledgePage: (pageId: string) => void;
  workspaceId: string;
  tx: (zh: string, en: string) => string;
}) {
  const sourceHref = buildDocumentSourceHref(document, workspaceId);

  return (
    <div className="knowledge-viewer">
      <div className="knowledge-viewer__header">
        <div>
          <h1>{document.title}</h1>
          <div className="knowledge-viewer__tags">
            <span className="knowledge-tag">{document.sourceType === "attachment" ? tx("共享附件", "Shared attachment") : tx("共享文档", "Shared document")}</span>
            <span className="knowledge-tag">{document.isMarkdown ? "MD" : document.mediaType}</span>
            {document.linkedKnowledgePages.length > 0 ? (
              <span className="knowledge-tag">{tx("已沉淀到知识页", "Linked to knowledge")}</span>
            ) : null}
          </div>
        </div>
        <div className="knowledge-viewer__actions">
          {sourceHref ? (
            <a className="knowledge-btn knowledge-btn--ghost" href={sourceHref} rel="noreferrer" target="_blank">
              {tx("打开原文", "Open source")}
            </a>
          ) : null}
          {document.sourceType === "attachment" && document.isMarkdown && document.linkedChannelDocuments.length === 0 ? (
            <button
              className="knowledge-btn knowledge-btn--ghost"
              disabled={isPending || !document.channelName}
              onClick={() => onCreateChannelDocument(document)}
              type="button"
            >
              {tx("转群文档", "Create shared document")}
            </button>
          ) : null}
          {document.linkedKnowledgePages.length > 0 ? (
            <button
              className="knowledge-btn knowledge-btn--primary"
              onClick={() => onOpenLinkedKnowledgePage(document.linkedKnowledgePages[0]!.id)}
              type="button"
            >
              {tx("查看知识页面", "Open knowledge page")}
            </button>
          ) : document.isMarkdown ? (
            <button
              className="knowledge-btn knowledge-btn--primary"
              disabled={isPending}
              onClick={() => onCreateKnowledgePage(document)}
              type="button"
            >
              {tx("沉淀为知识页面", "Create knowledge page")}
            </button>
          ) : null}
        </div>
      </div>

      <div className="knowledge-viewer__meta">
        {[
          document.channelName ? `${tx("来源群组", "Channel")}: #${document.channelName}` : null,
          document.sourceSpeaker ? `${tx("分享者", "Shared by")}: ${translateSystemSpeaker(document.sourceSpeaker, tx)}` : null,
          `${tx("更新时间", "Updated")}: ${formatKnowledgeTime(document.updatedAt || document.sourceTime)}`,
          `${tx("大小", "Size")}: ${formatDocumentSize(document.sizeBytes)}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </div>

      {document.linkedKnowledgePages.length > 0 ? (
        <div className="knowledge-viewer__tags">
          {document.linkedKnowledgePages.map((page) => (
            <button
              className="knowledge-tag knowledge-tag--button"
              key={page.id}
              onClick={() => onOpenLinkedKnowledgePage(page.id)}
              type="button"
            >
              {page.title}
            </button>
          ))}
        </div>
      ) : null}

      {document.linkedChannelDocuments.length > 0 ? (
        <div className="knowledge-viewer__tags">
          {document.linkedChannelDocuments.map((linkedDocument) => (
            <button
              className="knowledge-tag knowledge-tag--button"
              key={linkedDocument.id}
              onClick={() => onOpenDocumentPage(`channelDocument:${linkedDocument.id}`)}
              type="button"
            >
              {tx("群文档", "Shared doc")} · {linkedDocument.title}
            </button>
          ))}
        </div>
      ) : null}

      {document.sourceAttachmentId ? (
        <div className="knowledge-viewer__tags">
          <button
            className="knowledge-tag knowledge-tag--button"
            onClick={() => onOpenDocumentPage(`attachment:${document.sourceAttachmentId}`)}
            type="button"
          >
            {tx("来源附件", "Source attachment")}
          </button>
        </div>
      ) : null}

      <div className="knowledge-viewer__body">
        {document.isMarkdown ? (
          <div className="knowledge-viewer__md-container" data-color-mode="light">
            <MDEditor.Markdown
              source={document.previewText || tx("暂无内容", "No content yet")}
              style={{ minHeight: 120, padding: "16px 20px", background: "transparent" }}
            />
          </div>
        ) : (
          <div className="knowledge-document-note">
            {tx(
              "该共享文档不是 Markdown，因此不会直接进入知识页面；它会继续停留在文档页面中供追踪和打开。",
              "This shared document is not Markdown, so it stays in document pages for tracking instead of becoming a knowledge page directly.",
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function buildDocumentSourceHref(document: KnowledgeDocumentPageRecord, workspaceId: string): string | null {
  if (document.sourceType === "attachment") {
    return `/api/attachments/${document.sourceId}`;
  }

  if (!document.channelName) {
    return null;
  }

  if (!workspaceId) {
    return null;
  }

  const search = new URLSearchParams();
  search.set("focus", `channel-${document.channelName}`);
  search.set("doc", document.sourceId);
  return buildWorkspacePath(workspaceId, `/im?${search.toString()}`);
}

function formatKnowledgeTime(value?: string): string {
  return formatCompactTimestamp(value, { emptyFallback: "—" });
}

function formatDocumentSize(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return "0 B";
  }
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
