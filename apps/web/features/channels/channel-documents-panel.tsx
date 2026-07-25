"use client";

import { useEffect, useState } from "react";
import type {
  ChannelsPageData,
  ChannelFileRecord,
  ChannelDocumentChangeSetRecord,
  ChannelDocumentConflictRecord,
  ChannelDocumentRecord,
  ChannelDocumentRunRecord,
} from "@/features/dashboard/data";
import type { ChannelDocumentAccessRole } from "@agent-space/domain";
import { EmptyState } from "@/shared/ui/empty-state";
import { FeedbackBanner } from "@/shared/ui/feedback-banner";
import { formatCompactTimestamp } from "@/shared/lib/time-format";
import { translateSystemSpeaker } from "@/features/i18n/presentation";

export function ChannelDocumentsPanel({
  archivedDocuments,
  documents,
  selectedDocument,
  selectedDocumentId,
  selectedDocumentConflicts,
  createMode = "markdown",
  draftTitle,
  draftSummary,
  draftContent,
  currentVersionId,
  runs,
  conflicts,
  channelFiles,
  pending,
  feedback,
  hasRecoverableDraft,
  onSelectDocument,
  onCreateNew,
  onDraftTitleChange,
  onDraftSummaryChange,
  onDraftContentChange,
  onBeginEditing,
  onRestoreRecoverableDraft,
  onDismissRecoverableDraft,
  onSave,
  onArchive,
  onRestoreArchived,
  onRollback,
  onResolveConflict,
  onRetryConflict,
  onLoadConflictDraft,
  onUpdateCollaboratorRole,
  onAddCollaborator,
  onRemoveCollaborator,
  onExport,
  onImportAttachment,
  onDeleteAttachment = () => undefined,
  onViewDocumentInKnowledge,
  onViewAttachmentInKnowledge,
  tx,
  panelKicker,
  panelTitle,
  emptyStateBody,
  googleWorkspace,
  onDisconnectGoogleWorkspace,
  onRefreshExternalSheet,
  onSyncExternalSheetPermissions,
}: {
  archivedDocuments: ChannelDocumentRecord[];
  documents: ChannelDocumentRecord[];
  googleWorkspace?: ChannelsPageData["googleWorkspace"];
  selectedDocument: ChannelDocumentRecord | null;
  selectedDocumentId: string | null;
  selectedDocumentConflicts: ChannelDocumentConflictRecord[];
  createMode?: "markdown" | "nativeSheet" | "nativeDeck" | "googleSheet" | "googleSheetCreate";
  draftTitle: string;
  draftSummary: string;
  draftContent: string;
  currentVersionId?: string;
  runs: ChannelDocumentRunRecord[];
  conflicts: ChannelDocumentConflictRecord[];
  channelFiles: ChannelFileRecord[];
  pending: boolean;
  feedback?: string | null;
  hasRecoverableDraft: boolean;
  onSelectDocument: (documentId: string | null) => void;
  onCreateNew: () => void;
  onDraftTitleChange: (value: string) => void;
  onDraftSummaryChange: (value: string) => void;
  onDraftContentChange: (value: string) => void;
  onBeginEditing: () => void;
  onRestoreRecoverableDraft: () => void;
  onDismissRecoverableDraft: () => void;
  onSave: () => void;
  onArchive: () => void;
  onRestoreArchived: (documentId: string) => void;
  onRollback: (versionId: string) => void;
  onResolveConflict: (conflictId: string) => void;
  onRetryConflict: (conflictId: string) => void;
  onLoadConflictDraft: (conflictId: string) => void;
  onUpdateCollaboratorRole: (input: {
    actorId: string;
    actorType: "human" | "agent";
    role: ChannelDocumentAccessRole;
  }) => void;
  onAddCollaborator: (input: {
    actorId: string;
    actorType: "human" | "agent";
    role: ChannelDocumentAccessRole;
  }) => void;
  onRemoveCollaborator: (input: {
    actorId: string;
    actorType: "human" | "agent";
  }) => void;
  onExport: () => void;
  onImportAttachment: (attachmentId: string, fileName: string) => void;
  onDeleteAttachment?: (file: ChannelFileRecord) => void;
  onViewDocumentInKnowledge: (documentId: string) => void;
  onViewAttachmentInKnowledge: (attachmentId: string) => void;
  onDisconnectGoogleWorkspace?: () => void;
  onRefreshExternalSheet?: () => void;
  onSyncExternalSheetPermissions?: () => void;
  tx: (zh: string, en: string) => string;
  panelKicker?: string;
  panelTitle?: string;
  emptyStateBody?: string;
}) {
  const selectedDocumentEditingHumans =
    selectedDocument?.activePresences.filter(
      (presence) => presence.actorType === "human" && presence.status === "editing" && !presence.isCurrentUser,
    ) ?? [];
  const selectedDocumentProcessingAgents =
    selectedDocument?.activePresences.filter((presence) => presence.actorType === "agent" && presence.status === "processing") ?? [];
  const currentUserRole = selectedDocument?.currentUserRole ?? "viewer";
  const canEditDocument = !selectedDocument || currentUserRole === "owner" || currentUserRole === "forwarder" || currentUserRole === "editor";
  const canManageDocument = selectedDocument ? currentUserRole === "owner" : false;
  const isLinkingGoogleSheet = !selectedDocument && createMode === "googleSheet";
  const isCreatingGoogleSheet = !selectedDocument && createMode === "googleSheetCreate";
  const isCreatingNativeSheet = !selectedDocument && createMode === "nativeSheet";
  const isCreatingNativeDeck = !selectedDocument && createMode === "nativeDeck";
  const isGoogleSheetCreateFlow = isLinkingGoogleSheet || isCreatingGoogleSheet;
  const isNativeStructuredCreateFlow = isCreatingNativeSheet || isCreatingNativeDeck;
  const isExternalGoogleSheet = Boolean(selectedDocument?.externalSheet);
  const canEditMarkdownContent = canEditDocument && !isExternalGoogleSheet;
  const ownerCount = selectedDocument?.collaborators.filter((collaborator) => collaborator.role === "owner").length ?? 0;
  const googleWorkspaceConnected = googleWorkspace?.status === "connected";
  const [selectedCandidateKey, setSelectedCandidateKey] = useState("");
  const [selectedCandidateRole, setSelectedCandidateRole] = useState<ChannelDocumentAccessRole>("editor");

  useEffect(() => {
    const firstCandidate = selectedDocument?.availableCollaborators[0];
    setSelectedCandidateKey(firstCandidate ? `${firstCandidate.actorType}:${firstCandidate.actorId}` : "");
    setSelectedCandidateRole("editor");
  }, [selectedDocument?.id, selectedDocument?.availableCollaborators]);

  return (
    <section className="channel-documents-panel">
      <div className="channel-documents-panel__sidebar">
        <div className="panel-header">
          <div>
            {panelKicker ? <p className="page-eyebrow">{panelKicker}</p> : null}
            <h3>{panelTitle ?? tx("群组文档", "Group documents")}</h3>
          </div>
          <button className="workspace-square-button" disabled={pending} onClick={onCreateNew} type="button">
            +
          </button>
        </div>

        <div className="channel-documents-panel__list">
          {documents.length > 0 ? (
            documents.map((document) => (
              <button
                className={`channel-documents-panel__list-item${selectedDocumentId === document.id ? " channel-documents-panel__list-item--active" : ""}`}
                key={document.id}
                onClick={() => onSelectDocument(document.id)}
                type="button"
              >
                <strong>{document.title}</strong>
                <span>{document.summary || tx("暂无摘要", "No summary yet")}</span>
                {document.externalSheet ? (
                  <small>
                    {tx("Google Sheet", "Google Sheet")} · {formatExternalSheetStatusLabel(document.externalSheet.syncStatus, tx)}
                  </small>
                ) : document.kind !== "markdown" ? (
                  <small>{formatDocumentKindLabel(document.kind, tx)}</small>
                ) : null}
                <small>
                  {tx("最后更新", "Updated")} · {translateSystemSpeaker(document.updatedBy, tx)} · {formatDocumentTime(document.updatedAt)}
                </small>
                {document.lastBackgroundSync?.isRecent ? (
                  <small>
                    {tx("最近后台同步", "Recent background sync")} · {translateSystemSpeaker(document.lastBackgroundSync.actorId, tx)} ·{" "}
                    {formatDocumentTime(document.lastBackgroundSync.createdAt)}
                  </small>
                ) : null}
                {renderPresenceSummary(document, tx)}
                {document.conflictCount > 0 ? (
                  <small className="channel-documents-panel__conflict">
                    {tx(`有 ${document.conflictCount} 个冲突待处理`, `${document.conflictCount} open conflict(s)`)}
                  </small>
                ) : null}
              </button>
            ))
          ) : (
            <EmptyState
              body={emptyStateBody ?? tx("创建群组文档", "Create group document")}
              title={tx("还没有文档", "No documents yet")}
            />
          )}

          {archivedDocuments.length > 0 ? (
            <div className="channel-documents-panel__archived">
              <div className="channel-documents-panel__archived-header">
                <strong>{tx("已删除文档", "Deleted documents")}</strong>
                <span>{archivedDocuments.length}</span>
              </div>
              {archivedDocuments.map((document) => (
                <div className="channel-documents-panel__archived-item" key={document.id}>
                  <div>
                    <strong>{document.title}</strong>
                    <small>
                      {tx("最后更新", "Updated")} · {translateSystemSpeaker(document.updatedBy, tx)} · {formatDocumentTime(document.updatedAt)}
                    </small>
                  </div>
                  <button
                    className="action-button"
                    disabled={pending}
                    onClick={() => onRestoreArchived(document.id)}
                    type="button"
                  >
                    {tx("恢复", "Restore")}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="channel-documents-panel__editor">
        {feedback ? (
          <FeedbackBanner feedback={{ tone: "error", message: feedback }} />
        ) : null}
        {selectedDocumentConflicts.length > 0 ? (
          <FeedbackBanner
            message={tx(
              `${selectedDocumentConflicts.length} 条冲突待处理。`,
              `${selectedDocumentConflicts.length} open conflict record(s).`,
            )}
            title={tx("有冲突待处理", "Open conflicts")}
            tone="error"
          />
        ) : null}
        {selectedDocumentEditingHumans.length > 0 || selectedDocumentProcessingAgents.length > 0 ? (
          <FeedbackBanner role="alert" title={tx("正在协作中", "Collaboration in progress")} tone="success">
            {selectedDocumentEditingHumans.length > 0 ? (
              <p>
                {tx(
                  `正在编辑：${selectedDocumentEditingHumans.map((presence) => presence.actorId).join("、")}`,
                  `Editing: ${selectedDocumentEditingHumans.map((presence) => presence.actorId).join(", ")}.`,
                )}
              </p>
            ) : null}
            {selectedDocumentProcessingAgents.length > 0 ? (
              <p>
                {tx(
                  `处理中：${selectedDocumentProcessingAgents.map((presence) => presence.actorId).join("、")}`,
                  `Processing: ${selectedDocumentProcessingAgents.map((presence) => presence.actorId).join(", ")}.`,
                )}
              </p>
            ) : null}
          </FeedbackBanner>
        ) : null}
        {selectedDocument?.lastBackgroundSync ? (
          <FeedbackBanner role="alert" title={tx("当前版本来自后台写入", "This version came from a background update")} tone="success">
            <p>
              {tx(
                `${translateSystemSpeaker(selectedDocument.lastBackgroundSync.actorId, tx)} 于 ${formatDocumentTime(selectedDocument.lastBackgroundSync.createdAt)} 通过 ${
                  selectedDocument.lastBackgroundSync.triggerType === "handoff" ? "handoff" : "agent"
                } 写入了当前版本。`,
                `${translateSystemSpeaker(selectedDocument.lastBackgroundSync.actorId, tx)} wrote the current version at ${formatDocumentTime(selectedDocument.lastBackgroundSync.createdAt)} via ${
                  selectedDocument.lastBackgroundSync.triggerType === "handoff" ? "handoff" : "agent"
                }.`,
              )}
            </p>
            {selectedDocument.lastBackgroundSync.sourceMessage ? (
              <p>
                {tx(
                  `触发消息：${translateSystemSpeaker(selectedDocument.lastBackgroundSync.sourceMessage.speaker, tx)} · ${selectedDocument.lastBackgroundSync.sourceMessage.summary}`,
                  `Source message: ${translateSystemSpeaker(selectedDocument.lastBackgroundSync.sourceMessage.speaker, tx)} · ${selectedDocument.lastBackgroundSync.sourceMessage.summary}`,
                )}
              </p>
            ) : null}
            {selectedDocument.lastBackgroundSync.sourceStep ? (
              <p>
                {tx(
                  `来源步骤：${selectedDocument.lastBackgroundSync.sourceStep.agentLabel} · ${selectedDocument.lastBackgroundSync.sourceStep.instruction}`,
                  `Source step: ${selectedDocument.lastBackgroundSync.sourceStep.agentLabel} · ${selectedDocument.lastBackgroundSync.sourceStep.instruction}`,
                )}
              </p>
            ) : null}
          </FeedbackBanner>
        ) : null}
        {selectedDocument?.externalSheet ? (
          <FeedbackBanner
            role="status"
            title={tx("Google Sheet 已连接", "Google Sheet connected")}
            tone={selectedDocument.externalSheet.syncStatus === "ok" ? "success" : "error"}
          >
            <p>
              {tx("状态", "Status")} · {formatExternalSheetStatusLabel(selectedDocument.externalSheet.syncStatus, tx)}
              {selectedDocument.externalSheet.externalRevisionId ? ` · rev ${selectedDocument.externalSheet.externalRevisionId}` : ""}
            </p>
            {selectedDocument.externalSheet.externalUpdatedAt ? (
              <p>
                {tx("外部更新时间", "External updated")} · {formatDocumentTime(selectedDocument.externalSheet.externalUpdatedAt)}
              </p>
            ) : null}
            <div className="detail-actions">
              <a className="action-button" href={selectedDocument.externalSheet.externalUrl} rel="noreferrer" target="_blank">
                {tx("打开 Google Sheet", "Open Google Sheet")}
              </a>
              <button
                className="action-button"
                disabled={pending || !onRefreshExternalSheet}
                onClick={onRefreshExternalSheet}
                type="button"
              >
                {tx("刷新状态", "Refresh status")}
              </button>
              <button
                className="action-button"
                disabled={pending || !onSyncExternalSheetPermissions || !canManageDocument}
                onClick={onSyncExternalSheetPermissions}
                type="button"
              >
                {tx("同步权限", "Sync permissions")}
              </button>
              {selectedDocument.externalSheet.syncStatus === "permission_error" || !googleWorkspaceConnected ? (
                <a className="action-button" href="/api/integrations/google/start">
                  {tx("重新连接", "Reconnect")}
                </a>
              ) : null}
              {googleWorkspaceConnected && onDisconnectGoogleWorkspace ? (
                <button className="action-button action-button--danger" disabled={pending} onClick={onDisconnectGoogleWorkspace} type="button">
                  {tx("断开 Google", "Disconnect Google")}
                </button>
              ) : null}
            </div>
          </FeedbackBanner>
        ) : null}
        {hasRecoverableDraft ? (
          <FeedbackBanner role="alert" title={tx("已保留未保存的草稿", "Unsaved draft preserved")} tone="success">
            <p>
              {tx(
                "当前显示最新版本。可恢复草稿后手动合并。",
                "The latest version is shown. Restore your draft to merge manually.",
              )}
            </p>
            <div className="detail-actions">
              <button className="action-button" disabled={pending} onClick={onRestoreRecoverableDraft} type="button">
                {tx("恢复刚才的草稿", "Restore previous draft")}
              </button>
              <button className="action-button" disabled={pending} onClick={onDismissRecoverableDraft} type="button">
                {tx("保留最新版本", "Keep latest version")}
              </button>
            </div>
          </FeedbackBanner>
        ) : null}
        <div className="panel-header">
          <div>
            <h3>
              {draftTitle.trim() ||
                (isCreatingGoogleSheet
                  ? tx("创建 Google Sheet", "Create Google Sheet")
                  : isLinkingGoogleSheet
                    ? tx("链接 Google Sheet", "Link Google Sheet")
                    : isCreatingNativeSheet
                      ? tx("新建表格", "New sheet")
                      : isCreatingNativeDeck
                        ? tx("新建 Deck", "New deck")
                        : tx("新建文档", "New document"))}
            </h3>
            {selectedDocumentId ? (
              <p className="panel-note">
                {tx("正在编辑已有文档", "Editing existing document")}
                {currentVersionId ? ` · ${tx("版本", "Version")} ${currentVersionId}` : ""}
              </p>
            ) : null}
          </div>
          <div className="detail-actions">
            {selectedDocumentId ? (
              <button className="action-button" disabled={pending || !canEditDocument} onClick={onExport} type="button">
                {tx("导出附件", "Export attachment")}
              </button>
            ) : null}
            {selectedDocumentId ? (
              <button className="action-button action-button--danger" disabled={pending || !canManageDocument} onClick={onArchive} type="button">
                {tx("删除", "Delete")}
              </button>
            ) : null}
            <button
              className="primary-button"
              disabled={
                pending ||
                (!isGoogleSheetCreateFlow && (!canEditMarkdownContent || draftTitle.trim().length === 0)) ||
                (isNativeStructuredCreateFlow && draftTitle.trim().length === 0) ||
                (isCreatingGoogleSheet && (draftTitle.trim().length === 0 || !googleWorkspaceConnected)) ||
                (isLinkingGoogleSheet && (draftTitle.trim().length === 0 || draftContent.trim().length === 0))
              }
              onClick={onSave}
              type="button"
            >
              {pending
                ? tx("保存中...", "Saving...")
                : isCreatingGoogleSheet
                  ? tx("创建", "Create")
                  : isLinkingGoogleSheet
                    ? tx("链接", "Link")
                    : isNativeStructuredCreateFlow
                      ? tx("创建", "Create")
                    : tx("保存", "Save")}
            </button>
          </div>
        </div>
        {selectedDocument ? (
          <p className="panel-note">
            {tx("我的权限", "My role")} · {formatDocumentRoleLabel(currentUserRole, tx)}
            {!canEditDocument ? ` · ${tx("当前为只读", "Read only")}` : ""}
          </p>
        ) : null}
        {selectedDocument && selectedDocument.currentUserRole === "viewer" ? (
          <FeedbackBanner
            message={tx("只读。不能保存、回滚、导出或处理冲突。", "Read only. You cannot save, roll back, export, or resolve conflicts.")}
            role="alert"
            title={tx("只读权限", "Read-only access")}
            tone="success"
          />
        ) : null}

        <div className="form-grid">
          <label className="form-field form-field--full">
            <span>{tx("标题", "Title")}</span>
            <input
              disabled={!canEditMarkdownContent && !isGoogleSheetCreateFlow}
              onFocus={onBeginEditing}
              onChange={(event) => onDraftTitleChange(event.currentTarget.value)}
              placeholder={tx("标题", "Title")}
              type="text"
              value={draftTitle}
            />
          </label>
          <label className="form-field form-field--full">
            <span>{tx("摘要", "Summary")}</span>
            <input
              disabled={!canEditMarkdownContent && !isGoogleSheetCreateFlow}
              onFocus={onBeginEditing}
              onChange={(event) => onDraftSummaryChange(event.currentTarget.value)}
              placeholder={tx("简短摘要", "Short summary")}
              type="text"
              value={draftSummary}
            />
          </label>
          {isCreatingGoogleSheet ? (
            <div className="channel-documents-panel__workflow-item">
              <strong>{tx("将创建新的 Google Sheet", "A new Google Sheet will be created")}</strong>
              <span>
                {googleWorkspaceConnected
                  ? tx(
                      `已连接 ${googleWorkspace.email ?? "Google Workspace"}`,
                      `Connected as ${googleWorkspace.email ?? "Google Workspace"}`,
                    )
                  : tx("未连接 Google Workspace", "Google Workspace is not connected")}
              </span>
              <div className="detail-actions">
                {!googleWorkspaceConnected ? (
                  <a className="action-button" href="/api/integrations/google/start">
                    {tx("连接 Google Workspace", "Connect Google Workspace")}
                  </a>
                ) : null}
                {googleWorkspaceConnected && onDisconnectGoogleWorkspace ? (
                  <button className="action-button action-button--danger" disabled={pending} onClick={onDisconnectGoogleWorkspace} type="button">
                    {tx("断开 Google", "Disconnect Google")}
                  </button>
                ) : null}
              </div>
            </div>
          ) : isLinkingGoogleSheet ? (
            <>
              <div className="channel-documents-panel__workflow-item">
                <strong>{tx("绑定已有 Google Sheet", "Bind existing Google Sheet")}</strong>
                <span>
                  {googleWorkspaceConnected
                    ? tx(
                        `已连接 ${googleWorkspace.email ?? "Google Workspace"}`,
                        `Connected as ${googleWorkspace.email ?? "Google Workspace"}`,
                      )
                    : tx("仅保存外部链接；API 写入需要连接 Google Workspace", "Only the external link is stored; API writes require Google Workspace")}
                </span>
                <div className="detail-actions">
                  {!googleWorkspaceConnected ? (
                    <a className="action-button" href="/api/integrations/google/start">
                      {tx("连接 Google Workspace", "Connect Google Workspace")}
                    </a>
                  ) : null}
                  {googleWorkspaceConnected && onDisconnectGoogleWorkspace ? (
                    <button className="action-button action-button--danger" disabled={pending} onClick={onDisconnectGoogleWorkspace} type="button">
                      {tx("断开 Google", "Disconnect Google")}
                    </button>
                  ) : null}
                </div>
              </div>
              <label className="form-field form-field--full">
                <span>{tx("Google Sheet URL", "Google Sheet URL")}</span>
                <textarea
                  className="channel-documents-panel__textarea"
                  disabled={pending}
                  onFocus={onBeginEditing}
                  onChange={(event) => onDraftContentChange(event.currentTarget.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  rows={4}
                  value={draftContent}
                />
              </label>
            </>
          ) : isExternalGoogleSheet ? (
            <div className="channel-documents-panel__workflow-item">
              <strong>{tx("表格内容在 Google Sheets 中编辑", "Sheet content is edited in Google Sheets")}</strong>
              <span>
                {tx(
                  "agent.dofe 会保留链接、权限状态和 agent 操作记录。",
                  "agent.dofe keeps the link, permission state, and agent operation history.",
                )}
              </span>
            </div>
          ) : (
            <label className="form-field form-field--full">
              <span>
                {isCreatingNativeSheet || selectedDocument?.kind === "sheet"
                    ? tx("表格草稿", "Sheet draft")
                    : isCreatingNativeDeck || selectedDocument?.kind === "deck"
                      ? tx("Deck 草稿", "Deck draft")
                      : tx("Markdown 内容", "Markdown content")}
              </span>
              <textarea
                className="channel-documents-panel__textarea"
                disabled={!canEditMarkdownContent}
                onFocus={onBeginEditing}
                onChange={(event) => onDraftContentChange(event.currentTarget.value)}
                rows={14}
                value={draftContent}
              />
            </label>
          )}
        </div>
      </div>

      {runs.length > 0 || conflicts.length > 0 || (selectedDocument?.externalSheetOperations.length ?? 0) > 0 ? (
        <div className="channel-documents-panel__activity">
          {selectedDocument?.externalSheetOperations.length ? (
            <section className="channel-documents-panel__activity-card">
              <div className="panel-header">
                <div>
                  <h3>{tx("Google Sheet 操作", "Google Sheet operations")}</h3>
                </div>
              </div>
              <div className="channel-documents-panel__workflow-list">
                {selectedDocument.externalSheetOperations.slice(0, 8).map((operation) => (
                  <div className="channel-documents-panel__workflow-item" key={operation.id}>
                    <strong>{operation.intent}</strong>
                    <span>
                      {operation.actorId} · {formatExternalSheetOperationStatusLabel(operation.status, tx)} ·{" "}
                      {formatExternalSheetOperationTypeLabel(operation.operationType, tx)}
                    </span>
                    {operation.delegatedGoogleEmail || operation.delegatedUserDisplayName ? (
                      <small>
                        {tx("授权账号", "Delegated account")} · {operation.delegatedGoogleEmail ?? operation.delegatedUserDisplayName}
                      </small>
                    ) : null}
                    {operation.rangeA1 ? <small>{tx("范围", "Range")} · {operation.rangeA1}</small> : null}
                    <small>
                      {operation.requestSummary}
                      {operation.affectedRows !== undefined ? ` · ${tx("行", "Rows")} ${operation.affectedRows}` : ""}
                      {operation.affectedCells !== undefined ? ` · ${tx("单元格", "Cells")} ${operation.affectedCells}` : ""}
                    </small>
                    {operation.responseSummary ? <small>{operation.responseSummary}</small> : null}
                    {operation.errorMessage ? (
                      <small className="channel-documents-panel__conflict">
                        {operation.errorCode ? `${operation.errorCode} · ` : ""}{operation.errorMessage}
                      </small>
                    ) : null}
                    <small>
                      {formatDocumentTime(operation.startedAt)}
                      {operation.finishedAt ? ` → ${formatDocumentTime(operation.finishedAt)}` : ""}
                    </small>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {runs.length > 0 ? (
            <section className="channel-documents-panel__activity-card">
              <div className="panel-header">
                <div>
                  <h3>{tx("协作流程", "Collaboration runs")}</h3>
                </div>
              </div>
              <div className="channel-documents-panel__workflow-list">
                {runs.map((run) => (
                  <div className="channel-documents-panel__workflow-item" key={run.id}>
                    <strong>{run.sourceSummary}</strong>
                    <span>{tx("状态", "Status")} · {formatRunStatusLabel(run.status, tx)}</span>
                    <div className="channel-documents-panel__workflow-steps">
                      {run.steps.map((step) => (
                        <small key={step.id}>
                          {step.agentLabel} · {formatRunStepStatusLabel(step.status, tx)} · {step.instruction}
                          {step.lastWarning ? ` · ${step.lastWarning}` : ""}
                        </small>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {conflicts.length > 0 ? (
            <section className="channel-documents-panel__activity-card">
              <div className="panel-header">
                <div>
                  <h3>{tx("待处理冲突", "Open conflicts")}</h3>
                </div>
              </div>
              <div className="channel-documents-panel__workflow-list">
                {conflicts.map((conflict) => (
                  <div className="channel-documents-panel__workflow-item" key={conflict.id}>
                    <strong>{conflict.documentTitle}</strong>
                    <span>
                      {tx("块", "Block")} · {conflict.blockId} · {formatDocumentTime(conflict.createdAt)}
                    </span>
                    {conflict.leftChangeSet ? (
                      <small>
                        {tx("左侧变更", "Left change")} · {formatChangeSetLabel(conflict.leftChangeSet, tx)}
                      </small>
                    ) : null}
                    {conflict.rightChangeSet ? (
                      <small>
                        {tx("右侧变更", "Right change")} · {formatChangeSetLabel(conflict.rightChangeSet, tx)}
                      </small>
                    ) : null}
                    {conflict.rightChangeSet?.sourceMessage ? (
                      <small>
                        {tx("触发消息", "Source message")} · {translateSystemSpeaker(conflict.rightChangeSet.sourceMessage.speaker, tx)} ·{" "}
                        {conflict.rightChangeSet.sourceMessage.summary}
                      </small>
                    ) : null}
                    {conflict.rightChangeSet?.sourceStep ? (
                      <small>
                        {tx("来源步骤", "Source step")} · {conflict.rightChangeSet.sourceStep.agentLabel} ·{" "}
                        {conflict.rightChangeSet.sourceStep.instruction}
                      </small>
                    ) : null}
                    {conflict.mergePreview ? (
                      <div className="channel-documents-panel__merge-grid">
                        <div className="channel-documents-panel__merge-column">
                          <strong>{conflict.mergePreview.currentLabel}</strong>
                          <pre className="channel-documents-panel__merge-preview">{conflict.mergePreview.currentContentMarkdown}</pre>
                        </div>
                        <div className="channel-documents-panel__merge-column">
                          <strong>{conflict.mergePreview.incomingLabel}</strong>
                          <pre className="channel-documents-panel__merge-preview">{conflict.mergePreview.incomingContentMarkdown}</pre>
                        </div>
                      </div>
                    ) : null}
                    <div className="detail-actions">
                      {conflict.mergePreview ? (
                        <button
                          className="action-button"
                          disabled={pending || !canEditDocument}
                          onClick={() => onLoadConflictDraft(conflict.id)}
                          type="button"
                        >
                          {tx("载入冲突改动到草稿", "Load conflicted change into draft")}
                        </button>
                      ) : null}
                      {conflict.rightChangeSet?.retryable ? (
                        <button
                          className="action-button"
                          disabled={pending || !canEditDocument}
                          onClick={() => onRetryConflict(conflict.id)}
                          type="button"
                        >
                          {tx("重新应用", "Retry change")}
                        </button>
                      ) : null}
                      <button
                        className="action-button"
                        disabled={pending}
                        onClick={() => onSelectDocument(conflict.documentId)}
                        type="button"
                      >
                        {tx("打开文档", "Open document")}
                      </button>
                      <button
                        className="action-button"
                        disabled={pending || !canEditDocument}
                        onClick={() => onResolveConflict(conflict.id)}
                        type="button"
                      >
                        {tx("标记已处理", "Mark resolved")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {(selectedDocument?.changeSets.length ?? 0) > 0 ||
      (selectedDocument?.versions.length ?? 0) > 0 ||
      channelFiles.length > 0 ? (
        <div className="channel-documents-panel__activity">
          {selectedDocument?.changeSets.length ? (
            <section className="channel-documents-panel__activity-card">
              <div className="panel-header">
                <div>
                  <h3>{tx("最近改动", "Recent changes")}</h3>
                </div>
              </div>
              <div className="channel-documents-panel__workflow-list">
                {selectedDocument.changeSets.slice(0, 6).map((changeSet) => (
                  <div className="channel-documents-panel__workflow-item" key={changeSet.id}>
                    <strong>{formatChangeSetLabel(changeSet, tx)}</strong>
                    <span>
                      {translateSystemSpeaker(changeSet.actorId, tx)} · {formatDocumentTime(changeSet.createdAt)}
                    </span>
                    {changeSet.documentVersionId ? (
                      <small>
                        {tx("写入版本", "Version")} · {changeSet.documentVersionId}
                      </small>
                    ) : (
                      <small>{tx("没有生成新版本", "No new version was written")}</small>
                    )}
                    <small>
                      {tx("基线版本", "Base version")} · {changeSet.baseVersionId}
                    </small>
                    {changeSet.sourceMessage ? (
                      <small>
                        {tx("触发消息", "Source message")} · {translateSystemSpeaker(changeSet.sourceMessage.speaker, tx)} ·{" "}
                        {changeSet.sourceMessage.summary}
                      </small>
                    ) : null}
                    {changeSet.sourceStep ? (
                      <small>
                        {tx("来源步骤", "Source step")} · {changeSet.sourceStep.agentLabel} ·{" "}
                        {changeSet.sourceStep.instruction}
                      </small>
                    ) : null}
                    {changeSet.sourceTask ? (
                      <small>
                        {tx("任务队列", "Task queue")} · {changeSet.sourceTask.title} · {changeSet.sourceTask.status}
                      </small>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {selectedDocument?.versions.length ? (
            <section className="channel-documents-panel__activity-card">
              <div className="panel-header">
                <div>
                  <h3>{tx("历史版本", "Version history")}</h3>
                </div>
              </div>
              <div className="channel-documents-panel__workflow-list">
                {selectedDocument.versions.map((version) => (
                  <div className="channel-documents-panel__workflow-item" key={version.id}>
                    <strong>{version.summary || tx("无摘要", "No summary")}</strong>
                    <span>
                      {translateSystemSpeaker(version.createdBy, tx)} · {formatDocumentTime(version.createdAt)}
                    </span>
                    <div className="detail-actions">
                      <button
                        className="action-button"
                        disabled={pending || !canEditDocument || version.id === currentVersionId}
                        onClick={() => onRollback(version.id)}
                        type="button"
                      >
                        {tx("回滚到此版本", "Rollback")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {channelFiles.length > 0 ? (
            <section className="channel-documents-panel__activity-card">
              <div className="panel-header">
                <div>
                  <h3>{tx("群组附件", "Group attachments")}</h3>
                </div>
              </div>
              <div className="channel-documents-panel__workflow-list">
                {channelFiles.map((file) => (
                  <div className="channel-documents-panel__workflow-item" key={file.id}>
                    <strong>{file.fileName}</strong>
                    <span>
                      {[translateSystemSpeaker(file.sourceSpeaker, tx) || tx("未知来源", "Unknown source"), file.sourceTime, formatFileLabel(file, tx)]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <div className="detail-actions">
                      <a className="action-button" href={`/api/attachments/${file.id}`} rel="noreferrer" target="_blank">
                        {tx("打开文件", "Open file")}
                      </a>
                      {file.isMarkdown ? (
                        <button
                          className="action-button"
                          disabled={pending}
                          onClick={() => onImportAttachment(file.id, file.fileName)}
                          type="button"
                        >
                          {tx("转成文档", "Import as document")}
                        </button>
                      ) : null}
                      {file.canDelete ? (
                        <button
                          className="action-button action-button--danger"
                          disabled={pending}
                          onClick={() => onDeleteAttachment(file)}
                          type="button"
                        >
                          {tx("删除文件", "Delete file")}
                        </button>
                      ) : file.deleteBlockedReason ? (
                        <button className="action-button" disabled title={file.deleteBlockedReason} type="button">
                          {tx("删除文件", "Delete file")}
                        </button>
                      ) : null}
                      <button
                        className="action-button"
                        onClick={() => onViewAttachmentInKnowledge(file.id)}
                        type="button"
                      >
                        {tx("在知识库中查看", "View in knowledge")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {selectedDocument ? (
        <div className="channel-documents-panel__activity">
          <section className="channel-documents-panel__activity-card">
            <div className="panel-header">
              <div>
                <h3>{tx("知识库映射", "Knowledge mapping")}</h3>
              </div>
            </div>
            <div className="channel-documents-panel__workflow-list">
              <div className="channel-documents-panel__workflow-item">
                <strong>{tx("在知识库中查看这份文档", "Open this document in knowledge")}</strong>
                <span>
                  {tx(
                    "跳转到知识库的文档页面，查看这份共享文档及其后续沉淀关系。",
                    "Jump to the knowledge document pages view to inspect this shared document and any linked knowledge pages.",
                  )}
                </span>
                <div className="detail-actions">
                  <button
                    className="action-button"
                    onClick={() => onViewDocumentInKnowledge(selectedDocument.id)}
                    type="button"
                  >
                    {tx("在知识库中查看", "View in knowledge")}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="channel-documents-panel__activity-card">
            <div className="panel-header">
              <div>
                <h3>{tx("协作者角色", "Collaborator roles")}</h3>
              </div>
            </div>
            <div className="channel-documents-panel__workflow-list">
              {selectedDocument.collaborators.map((collaborator) => (
                <div className="channel-documents-panel__workflow-item" key={`${collaborator.actorType}:${collaborator.actorId}`}>
                  <strong>
                    {collaborator.actorId}
                    {collaborator.isCurrentUser ? ` · ${tx("你", "You")}` : ""}
                  </strong>
                  <span>
                    {collaborator.actorType === "human" ? tx("人类成员", "Human") : tx("Agent", "Agent")} ·{" "}
                    {formatDocumentRoleLabel(collaborator.role, tx)}
                  </span>
                  {canManageDocument ? (
                    <label className="form-field form-field--full">
                      <span>{tx("角色", "Role")}</span>
                      <select
                        disabled={pending || (collaborator.role === "owner" && ownerCount <= 1)}
                        onChange={(event) =>
                          onUpdateCollaboratorRole({
                            actorId: collaborator.actorId,
                            actorType: collaborator.actorType,
                            role: event.currentTarget.value as ChannelDocumentAccessRole,
                          })
                        }
                        value={collaborator.role}
                      >
                        <option value="owner">{tx("Owner", "Owner")}</option>
                        <option value="forwarder">{tx("Forwarder", "Forwarder")}</option>
                        <option value="editor">{tx("Editor", "Editor")}</option>
                        <option value="viewer">{tx("Viewer", "Viewer")}</option>
                      </select>
                    </label>
                  ) : null}
                  {canManageDocument ? (
                    <div className="detail-actions">
                      <button
                        className="action-button action-button--danger"
                        disabled={pending || (collaborator.role === "owner" && ownerCount <= 1)}
                        onClick={() =>
                          onRemoveCollaborator({
                            actorId: collaborator.actorId,
                            actorType: collaborator.actorType,
                          })
                        }
                        type="button"
                      >
                        {tx("移除协作者", "Remove collaborator")}
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
              {canManageDocument && selectedDocument.availableCollaborators.length > 0 ? (
                <div className="channel-documents-panel__workflow-item">
                  <strong>{tx("新增协作者", "Add collaborator")}</strong>
                  <label className="form-field form-field--full">
                    <span>{tx("对象", "Collaborator")}</span>
                    <select
                      disabled={pending}
                      onChange={(event) => setSelectedCandidateKey(event.currentTarget.value)}
                      value={selectedCandidateKey}
                    >
                      {selectedDocument.availableCollaborators.map((candidate) => (
                        <option key={`${candidate.actorType}:${candidate.actorId}`} value={`${candidate.actorType}:${candidate.actorId}`}>
                          {candidate.label} · {candidate.subtitle}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="form-field form-field--full">
                    <span>{tx("初始角色", "Initial role")}</span>
                    <select
                      disabled={pending}
                      onChange={(event) => setSelectedCandidateRole(event.currentTarget.value as ChannelDocumentAccessRole)}
                      value={selectedCandidateRole}
                    >
                      <option value="owner">{tx("Owner", "Owner")}</option>
                      <option value="forwarder">{tx("Forwarder", "Forwarder")}</option>
                      <option value="editor">{tx("Editor", "Editor")}</option>
                      <option value="viewer">{tx("Viewer", "Viewer")}</option>
                    </select>
                  </label>
                  <div className="detail-actions">
                    <button
                      className="action-button"
                      disabled={pending || !selectedCandidateKey}
                      onClick={() => {
                        const [actorType, ...actorParts] = selectedCandidateKey.split(":");
                        const actorId = actorParts.join(":");
                        if (!actorId || (actorType !== "human" && actorType !== "agent")) {
                          return;
                        }
                        onAddCollaborator({
                          actorId,
                          actorType,
                          role: selectedCandidateRole,
                        });
                      }}
                      type="button"
                    >
                      {tx("添加协作者", "Add collaborator")}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function formatDocumentTime(value: string): string {
  return formatCompactTimestamp(value, { emptyFallback: value });
}

function formatChangeSetLabel(
  changeSet: ChannelDocumentChangeSetRecord,
  tx: (zh: string, en: string) => string,
): string {
  const statusLabel =
    changeSet.status === "applied"
      ? tx("已应用", "Applied")
      : changeSet.status === "conflicted"
        ? tx("有冲突", "Conflicted")
        : changeSet.status === "rejected"
          ? tx("已拒绝", "Rejected")
          : tx("待处理", "Pending");
  return `${changeSet.operationSummary} · ${statusLabel}`;
}

function renderPresenceSummary(
  document: ChannelDocumentRecord,
  tx: (zh: string, en: string) => string,
) {
  const editingHumans = document.activePresences.filter(
    (presence) => presence.actorType === "human" && presence.status === "editing" && !presence.isCurrentUser,
  );
  const processingAgents = document.activePresences.filter(
    (presence) => presence.actorType === "agent" && presence.status === "processing",
  );
  if (editingHumans.length === 0 && processingAgents.length === 0) {
    return null;
  }

  const labels: string[] = [];
  if (editingHumans.length > 0) {
    labels.push(
      tx(
        `${editingHumans.map((presence) => presence.actorId).join("、")} 正在编辑`,
        `${editingHumans.map((presence) => presence.actorId).join(", ")} editing`,
      ),
    );
  }
  if (processingAgents.length > 0) {
    labels.push(
      tx(
        `${processingAgents.map((presence) => presence.actorId).join("、")} 处理中`,
        `${processingAgents.map((presence) => presence.actorId).join(", ")} processing`,
      ),
    );
  }

  return <small>{labels.join(" · ")}</small>;
}

function formatDocumentRoleLabel(
  role: ChannelDocumentAccessRole,
  tx: (zh: string, en: string) => string,
): string {
  if (role === "owner") {
    return tx("Owner", "Owner");
  }
  if (role === "forwarder") {
    return tx("Forwarder", "Forwarder");
  }
  if (role === "editor") {
    return tx("Editor", "Editor");
  }
  return tx("Viewer", "Viewer");
}

function formatRunStatusLabel(
  status: ChannelDocumentRunRecord["status"],
  tx: (zh: string, en: string) => string,
): string {
  if (status === "pending") return tx("待开始", "Pending");
  if (status === "running") return tx("进行中", "Running");
  if (status === "completed_with_warning") return tx("已完成（有警告）", "Completed with warning");
  if (status === "completed") return tx("已完成", "Completed");
  return tx("失败", "Failed");
}

function formatRunStepStatusLabel(
  status: ChannelDocumentRunRecord["steps"][number]["status"],
  tx: (zh: string, en: string) => string,
): string {
  if (status === "pending") return tx("待开始", "Pending");
  if (status === "ready") return tx("就绪", "Ready");
  if (status === "queued") return tx("已入队", "Queued");
  if (status === "running") return tx("进行中", "Running");
  if (status === "completed_with_warning") return tx("已完成（有警告）", "Completed with warning");
  if (status === "completed") return tx("已完成", "Completed");
  if (status === "blocked") return tx("已阻塞", "Blocked");
  return tx("失败", "Failed");
}

function formatExternalSheetStatusLabel(
  status: NonNullable<ChannelDocumentRecord["externalSheet"]>["syncStatus"],
  tx: (zh: string, en: string) => string,
): string {
  if (status === "ok") return tx("已连接", "Connected");
  if (status === "permission_error") return tx("权限异常", "Permission issue");
  if (status === "missing") return tx("文件不可用", "Missing");
  return tx("未知", "Unknown");
}

function formatDocumentKindLabel(
  kind: ChannelDocumentRecord["kind"],
  tx: (zh: string, en: string) => string,
): string {
  if (kind === "sheet") return tx("内建表格", "Native sheet");
  if (kind === "deck") return tx("内建 Deck", "Native deck");
  if (kind === "document") return tx("文档", "Document");
  return tx("Markdown", "Markdown");
}

function formatExternalSheetOperationStatusLabel(
  status: ChannelDocumentRecord["externalSheetOperations"][number]["status"],
  tx: (zh: string, en: string) => string,
): string {
  if (status === "queued") return tx("已排队", "Queued");
  if (status === "running") return tx("进行中", "Running");
  if (status === "succeeded") return tx("已成功", "Succeeded");
  return tx("失败", "Failed");
}

function formatExternalSheetOperationTypeLabel(
  operationType: ChannelDocumentRecord["externalSheetOperations"][number]["operationType"],
  tx: (zh: string, en: string) => string,
): string {
  if (operationType === "append_rows") return tx("追加行", "Append rows");
  if (operationType === "append_text") return tx("追加文本", "Append text");
  if (operationType === "create") return tx("新建表格", "Create sheet");
  if (operationType === "update_values") return tx("更新单元格", "Update values");
  if (operationType === "batch_update") return tx("批量更新", "Batch update");
  if (operationType === "share") return tx("共享权限", "Share");
  if (operationType === "metadata_refresh") return tx("元数据刷新", "Metadata refresh");
  return tx("读取", "Read");
}

function formatFileLabel(
  file: ChannelFileRecord,
  tx: (zh: string, en: string) => string,
): string {
  const typeLabel = file.isMarkdown ? tx("Markdown", "Markdown") : file.mediaType;
  return `${typeLabel} · ${formatFileSize(file.sizeBytes)}`;
}

function formatFileSize(value: number): string {
  if (!Number.isFinite(value) || value < 1024) {
    return `${Math.max(0, Math.round(value))} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
