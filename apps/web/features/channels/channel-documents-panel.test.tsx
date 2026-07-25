import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChannelDocumentsPanel } from "@/features/channels/channel-documents-panel";
import type { ChannelDocumentRecord } from "@/features/dashboard/data";

const baseDocument: ChannelDocumentRecord = {
  id: "doc-1",
  channelName: "tour visit",
  title: "大阪-濑户内海行程",
  slug: "osaka-trip",
  kind: "markdown",
  storageMode: "native",
  currentVersionId: "ver-2",
  summary: "春季行程草稿",
  status: "active",
  updatedAt: "2026-04-07T09:30:00.000Z",
  updatedBy: "techwu",
  lastEditorType: "human",
  contentMarkdown: "## Day 1\n大阪",
  versionCount: 2,
  conflictCount: 1,
  versions: [
    {
      id: "ver-2",
      summary: "最新草稿",
      createdAt: "2026-04-07T09:30:00.000Z",
      createdBy: "techwu",
      createdByType: "human",
      triggerType: "manual",
    },
  ],
  changeSets: [
    {
      id: "changeset-1",
      documentId: "doc-1",
      actorId: "Atlas",
      actorType: "agent",
      baseVersionId: "ver-1",
      documentVersionId: "ver-2",
      status: "applied",
      sourceMessageId: "message-1",
      sourceTaskQueueId: "queue-1",
      createdAt: "2026-04-07T09:30:00.000Z",
      operationSummary: "整篇覆盖",
      sourceMessage: {
        id: "message-1",
        speaker: "你",
        summary: "@Atlas 继续完善",
        time: "09:28",
      },
      sourceTask: {
        id: "queue-1",
        title: "@提及 · tour visit · Atlas",
        status: "completed",
      },
      retryable: true,
      sourceStep: {
        id: "step-1",
        runId: "run-1",
        agentLabel: "Atlas",
        instruction: "继续完善文档",
        status: "completed",
      },
    },
  ],
  activePresences: [
    {
      actorId: "Nova",
      actorType: "human",
      status: "editing",
      updatedAt: "2026-04-07T09:32:00.000Z",
      isCurrentUser: false,
    },
    {
      actorId: "Atlas",
      actorType: "agent",
      status: "processing",
      updatedAt: "2026-04-07T09:33:00.000Z",
      isCurrentUser: false,
    },
  ],
  currentUserRole: "owner",
  collaborators: [
    {
      actorId: "techwu",
      actorType: "human",
      role: "owner",
      isCurrentUser: true,
    },
    {
      actorId: "Nova",
      actorType: "human",
      role: "editor",
      isCurrentUser: false,
    },
  ],
  availableCollaborators: [
    {
      actorId: "Atlas",
      actorType: "agent",
      label: "Atlas",
      subtitle: "Planner",
    },
  ],
  lastBackgroundSync: {
    actorId: "Atlas",
    actorType: "agent",
    triggerType: "handoff",
    versionId: "ver-2",
    createdAt: "2026-04-07T09:30:00.000Z",
    isRecent: true,
    sourceMessage: {
      id: "message-1",
      speaker: "你",
      summary: "@Atlas 继续完善",
      time: "09:28",
    },
    sourceStep: {
      id: "step-1",
      runId: "run-1",
      agentLabel: "Atlas",
      instruction: "继续完善文档",
      status: "completed",
    },
  },
  externalSheetOperations: [],
};

const archivedDocument: ChannelDocumentRecord = {
  ...baseDocument,
  id: "doc-archived-1",
  title: "旧版行程草稿",
  slug: "old-trip",
  status: "archived",
  currentVersionId: "ver-archived-1",
  conflictCount: 0,
  activePresences: [],
  lastBackgroundSync: undefined,
};

describe("ChannelDocumentsPanel", () => {
  it("translates system document actors in English", () => {
    const systemDocument: ChannelDocumentRecord = {
      ...baseDocument,
      updatedBy: "系统提示",
      versions: [
        {
          ...baseDocument.versions[0]!,
          createdBy: "系统提示",
        },
      ],
      changeSets: [
        {
          ...baseDocument.changeSets[0]!,
          actorId: "系统提示",
          sourceMessage: {
            ...baseDocument.changeSets[0]!.sourceMessage!,
            speaker: "系统提示",
          },
        },
      ],
      lastBackgroundSync: {
        ...baseDocument.lastBackgroundSync!,
        actorId: "系统提示",
        sourceMessage: {
          ...baseDocument.lastBackgroundSync!.sourceMessage!,
          speaker: "系统提示",
        },
      },
    };

    render(
      <ChannelDocumentsPanel
        archivedDocuments={[]}
        documents={[systemDocument]}
        selectedDocument={systemDocument}
        selectedDocumentId={systemDocument.id}
        selectedDocumentConflicts={[]}
        draftTitle={systemDocument.title}
        draftSummary={systemDocument.summary}
        draftContent={systemDocument.contentMarkdown}
        currentVersionId={systemDocument.currentVersionId}
        runs={[]}
        conflicts={[]}
        channelFiles={[]}
        pending={false}
        feedback={null}
        hasRecoverableDraft={false}
        onSelectDocument={vi.fn()}
        onCreateNew={vi.fn()}
        onDraftTitleChange={vi.fn()}
        onDraftSummaryChange={vi.fn()}
        onDraftContentChange={vi.fn()}
        onRestoreRecoverableDraft={vi.fn()}
        onDismissRecoverableDraft={vi.fn()}
        onBeginEditing={vi.fn()}
        onSave={vi.fn()}
        onArchive={vi.fn()}
        onRestoreArchived={vi.fn()}
        onRollback={vi.fn()}
        onResolveConflict={vi.fn()}
        onRetryConflict={vi.fn()}
        onLoadConflictDraft={vi.fn()}
        onUpdateCollaboratorRole={vi.fn()}
        onAddCollaborator={vi.fn()}
        onRemoveCollaborator={vi.fn()}
        onExport={vi.fn()}
        onImportAttachment={vi.fn()}
        onViewDocumentInKnowledge={vi.fn()}
        onViewAttachmentInKnowledge={vi.fn()}
        tx={(_, en) => en}
      />,
    );

    expect(screen.getByText("Updated · System Notice · 04/07")).toBeInTheDocument();
    expect(screen.getByText("Recent background sync · System Notice · 04/07")).toBeInTheDocument();
    expect(screen.getByText("Source message: System Notice · @Atlas 继续完善")).toBeInTheDocument();
    expect(screen.getByText("Source message · System Notice · @Atlas 继续完善")).toBeInTheDocument();
  });

  it("renders recoverable draft actions when the latest version replaced a stale save", async () => {
    const user = userEvent.setup();
    const onRestoreRecoverableDraft = vi.fn();
    const onDismissRecoverableDraft = vi.fn();
    const onResolveConflict = vi.fn();
    const onRetryConflict = vi.fn();
    const onLoadConflictDraft = vi.fn();
    const onBeginEditing = vi.fn();
    const onUpdateCollaboratorRole = vi.fn();
    const onAddCollaborator = vi.fn();
    const onRemoveCollaborator = vi.fn();

    render(
      <ChannelDocumentsPanel
        archivedDocuments={[]}
        documents={[baseDocument]}
        selectedDocument={baseDocument}
        selectedDocumentId={baseDocument.id}
        selectedDocumentConflicts={[
          {
            id: "conflict-1",
            documentId: baseDocument.id,
            documentTitle: baseDocument.title,
            blockId: "document-root",
            status: "open",
            createdAt: "2026-04-07T09:31:00.000Z",
          },
        ]}
        draftTitle={baseDocument.title}
        draftSummary={baseDocument.summary}
        draftContent={baseDocument.contentMarkdown}
        currentVersionId={baseDocument.currentVersionId}
        runs={[]}
        conflicts={[
          {
            id: "conflict-1",
            documentId: baseDocument.id,
            documentTitle: baseDocument.title,
            blockId: "document-root",
            status: "open",
            createdAt: "2026-04-07T09:31:00.000Z",
            leftChangeSet: baseDocument.changeSets[0],
            rightChangeSet: {
              ...baseDocument.changeSets[0],
              id: "changeset-2",
              actorId: "Nova",
              status: "conflicted",
              operationSummary: "替换 1 个块",
              retryable: true,
            },
            mergePreview: {
              mode: "block",
              currentLabel: "当前块",
              currentContentMarkdown: "## Day 1\n大阪",
              incomingLabel: "冲突改动",
              incomingContentMarkdown: "## Day 1\n奈良",
              suggestedDraftContentMarkdown: "## Day 1\n奈良",
            },
          },
        ]}
        channelFiles={[]}
        pending={false}
        feedback="这份文档在你编辑期间已被别人更新。"
        hasRecoverableDraft
        onSelectDocument={vi.fn()}
        onCreateNew={vi.fn()}
        onDraftTitleChange={vi.fn()}
        onDraftSummaryChange={vi.fn()}
        onDraftContentChange={vi.fn()}
        onRestoreRecoverableDraft={onRestoreRecoverableDraft}
        onDismissRecoverableDraft={onDismissRecoverableDraft}
        onBeginEditing={onBeginEditing}
        onSave={vi.fn()}
        onArchive={vi.fn()}
        onRestoreArchived={vi.fn()}
        onRollback={vi.fn()}
        onResolveConflict={onResolveConflict}
        onRetryConflict={onRetryConflict}
        onLoadConflictDraft={onLoadConflictDraft}
        onUpdateCollaboratorRole={onUpdateCollaboratorRole}
        onAddCollaborator={onAddCollaborator}
        onRemoveCollaborator={onRemoveCollaborator}
        onExport={vi.fn()}
        onImportAttachment={vi.fn()}
        onViewDocumentInKnowledge={vi.fn()}
        onViewAttachmentInKnowledge={vi.fn()}
        tx={(zh) => zh}
      />,
    );

    expect(screen.getByText("已保留未保存的草稿")).toBeInTheDocument();
    expect(screen.getByText("有冲突待处理")).toBeInTheDocument();
    expect(screen.getByText("正在协作中")).toBeInTheDocument();
    expect(screen.getByText("当前版本来自后台写入")).toBeInTheDocument();
    expect(screen.getByText("最近后台同步 · Atlas · 04/07")).toBeInTheDocument();
    expect(screen.getByText("正在编辑：Nova")).toBeInTheDocument();
    expect(screen.getByText("处理中：Atlas")).toBeInTheDocument();
    expect(screen.getByText("触发消息：你 · @Atlas 继续完善")).toBeInTheDocument();
    expect(screen.getByText("来源步骤：Atlas · 继续完善文档")).toBeInTheDocument();
    expect(screen.getByText("当前块")).toBeInTheDocument();
    expect(screen.getByText("冲突改动")).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes("## Day 1") && content.includes("奈良"))).toBeInTheDocument();
    expect(screen.getByText("最近改动")).toBeInTheDocument();
    expect(screen.getByText("协作者角色")).toBeInTheDocument();
    expect(screen.getByText("新增协作者")).toBeInTheDocument();
    expect(screen.getByText("整篇覆盖 · 已应用")).toBeInTheDocument();
    expect(screen.getAllByText("触发消息 · 你 · @Atlas 继续完善")).toHaveLength(2);
    expect(screen.getAllByText("来源步骤 · Atlas · 继续完善文档")).toHaveLength(2);
    expect(screen.getByText("Nova 正在编辑 · Atlas 处理中")).toBeInTheDocument();

    await user.click(screen.getByRole("textbox", { name: "标题" }));
    expect(onBeginEditing).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "载入冲突改动到草稿" }));
    expect(onLoadConflictDraft).toHaveBeenCalledWith("conflict-1");

    await user.click(screen.getByRole("button", { name: "重新应用" }));
    expect(onRetryConflict).toHaveBeenCalledWith("conflict-1");

    await user.click(screen.getByRole("button", { name: "标记已处理" }));
    expect(onResolveConflict).toHaveBeenCalledWith("conflict-1");

    await user.selectOptions(screen.getAllByDisplayValue("Editor")[0]!, "viewer");
    expect(onUpdateCollaboratorRole).toHaveBeenCalledWith({
      actorId: "Nova",
      actorType: "human",
      role: "viewer",
    });

    await user.click(screen.getAllByRole("button", { name: "移除协作者" })[1]!);
    expect(onRemoveCollaborator).toHaveBeenCalledWith({
      actorId: "Nova",
      actorType: "human",
    });

    await user.click(screen.getByRole("button", { name: "添加协作者" }));
    expect(onAddCollaborator).toHaveBeenCalledWith({
      actorId: "Atlas",
      actorType: "agent",
      role: "editor",
    });

    await user.click(screen.getByRole("button", { name: "恢复刚才的草稿" }));
    expect(onRestoreRecoverableDraft).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "保留最新版本" }));
    expect(onDismissRecoverableDraft).toHaveBeenCalledTimes(1);
  });

  it("renders channel files and keeps markdown files importable", async () => {
    const user = userEvent.setup();
    const onImportAttachment = vi.fn();

    render(
      <ChannelDocumentsPanel
        archivedDocuments={[]}
        documents={[baseDocument]}
        selectedDocument={baseDocument}
        selectedDocumentId={baseDocument.id}
        selectedDocumentConflicts={[]}
        draftTitle={baseDocument.title}
        draftSummary={baseDocument.summary}
        draftContent={baseDocument.contentMarkdown}
        currentVersionId={baseDocument.currentVersionId}
        runs={[]}
        conflicts={[]}
        channelFiles={[
          {
            id: "file-1",
            channelName: "tour visit",
            fileName: "itinerary_detailed.md",
            sourceMessageId: "message-1",
            sourceSpeaker: "你",
            sourceTime: "15:09",
            mediaType: "text/markdown",
            sizeBytes: 21564,
            kind: "file",
            isMarkdown: true,
            canDelete: true,
            retainedBecauseReferenced: false,
          },
          {
            id: "file-2",
            channelName: "tour visit",
            fileName: "cover.png",
            sourceMessageId: "message-2",
            sourceSpeaker: "Nova",
            sourceTime: "15:10",
            mediaType: "image/png",
            sizeBytes: 4096,
            kind: "image",
            isMarkdown: false,
            canDelete: false,
            deleteBlockedReason: "Only admins can delete this file.",
            retainedBecauseReferenced: false,
          },
        ]}
        pending={false}
        feedback={null}
        hasRecoverableDraft={false}
        onSelectDocument={vi.fn()}
        onCreateNew={vi.fn()}
        onDraftTitleChange={vi.fn()}
        onDraftSummaryChange={vi.fn()}
        onDraftContentChange={vi.fn()}
        onRestoreRecoverableDraft={vi.fn()}
        onDismissRecoverableDraft={vi.fn()}
        onBeginEditing={vi.fn()}
        onSave={vi.fn()}
        onArchive={vi.fn()}
        onRestoreArchived={vi.fn()}
        onRollback={vi.fn()}
        onResolveConflict={vi.fn()}
        onRetryConflict={vi.fn()}
        onLoadConflictDraft={vi.fn()}
        onUpdateCollaboratorRole={vi.fn()}
        onAddCollaborator={vi.fn()}
        onRemoveCollaborator={vi.fn()}
        onExport={vi.fn()}
        onImportAttachment={onImportAttachment}
        onViewDocumentInKnowledge={vi.fn()}
        onViewAttachmentInKnowledge={vi.fn()}
        tx={(zh) => zh}
      />,
    );

    expect(screen.getByText("群组附件")).toBeInTheDocument();
    expect(screen.getByText("itinerary_detailed.md")).toBeInTheDocument();
    expect(screen.getByText("cover.png")).toBeInTheDocument();
    expect(screen.getByText("你 · 15:09 · Markdown · 21.1 KB")).toBeInTheDocument();
    expect(screen.getByText("Nova · 15:10 · image/png · 4.0 KB")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "打开文件" })).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "转成文档" }));
    expect(onImportAttachment).toHaveBeenCalledWith("file-1", "itinerary_detailed.md");
  });

  it("renders archived documents and restores them on demand", async () => {
    const user = userEvent.setup();
    const onRestoreArchived = vi.fn();

    render(
      <ChannelDocumentsPanel
        archivedDocuments={[archivedDocument]}
        documents={[baseDocument]}
        selectedDocument={baseDocument}
        selectedDocumentId={baseDocument.id}
        selectedDocumentConflicts={[]}
        draftTitle={baseDocument.title}
        draftSummary={baseDocument.summary}
        draftContent={baseDocument.contentMarkdown}
        currentVersionId={baseDocument.currentVersionId}
        runs={[]}
        conflicts={[]}
        channelFiles={[]}
        pending={false}
        feedback={null}
        hasRecoverableDraft={false}
        onSelectDocument={vi.fn()}
        onCreateNew={vi.fn()}
        onDraftTitleChange={vi.fn()}
        onDraftSummaryChange={vi.fn()}
        onDraftContentChange={vi.fn()}
        onRestoreRecoverableDraft={vi.fn()}
        onDismissRecoverableDraft={vi.fn()}
        onBeginEditing={vi.fn()}
        onSave={vi.fn()}
        onArchive={vi.fn()}
        onRestoreArchived={onRestoreArchived}
        onRollback={vi.fn()}
        onResolveConflict={vi.fn()}
        onRetryConflict={vi.fn()}
        onLoadConflictDraft={vi.fn()}
        onUpdateCollaboratorRole={vi.fn()}
        onAddCollaborator={vi.fn()}
        onRemoveCollaborator={vi.fn()}
        onExport={vi.fn()}
        onImportAttachment={vi.fn()}
        onViewDocumentInKnowledge={vi.fn()}
        onViewAttachmentInKnowledge={vi.fn()}
        tx={(zh) => zh}
      />,
    );

    expect(screen.getByText("已删除文档")).toBeInTheDocument();
    expect(screen.getByText("旧版行程草稿")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "恢复" }));

    expect(onRestoreArchived).toHaveBeenCalledWith("doc-archived-1");
  });

});
