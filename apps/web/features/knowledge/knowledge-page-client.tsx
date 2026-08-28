"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { KnowledgeDocumentPageRecord, KnowledgePageData, KnowledgePageRecord } from "@/features/dashboard/data";
import { refreshWorkspaceModule } from "@/features/dashboard/workspace-module-refresh";
import type { KnowledgeAssignmentMode, KnowledgePage } from "@dofe-agent/domain/workspace";
import { createChannelDocumentFromAttachmentAction } from "@/features/channels/actions";
import {
  createKnowledgePageAction,
  createKnowledgePageFromDocumentAction,
  setKnowledgePageAssignmentsAction,
  updateKnowledgePageAction,
  deleteKnowledgePageAction,
  materialToKnowledgePageAction,
} from "./actions";
import { useLanguage } from "@/features/i18n/language-provider";
import { translateSystemSpeaker } from "@/features/i18n/presentation";
import { AppIcon } from "@/shared/ui/app-icon";
import { EmptyState } from "@/shared/ui/empty-state";
import { WorkbenchPageHeader } from "@/shared/ui/workbench-page-header";
import { WorkbenchPageFrame } from "@/shared/ui/workbench-page-frame";
import { formatCompactTimestamp } from "@/shared/lib/time-format";
import MDEditor, { commands } from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import { ParseTaskPanel } from "./parse-task-panel.tsx";
import {
  KnowledgeAssignmentDraftControls,
  KnowledgeAssignmentPanel,
  toggleEmployeeSelection,
} from "./assignment-panel.tsx";
import { DocumentPageViewer } from "./document-page-viewer.tsx";
import { KnowledgeTreeNode } from "./knowledge-tree-node.tsx";

type KnowledgeView = "knowledge" | "documents";

export function KnowledgePageClient({
  data,
  moduleSearchParams,
  onDataChanged,
}: {
  data: KnowledgePageData;
  moduleSearchParams?: URLSearchParams;
  onDataChanged?: () => void;
}) {
  const { tx } = useLanguage();
  const router = useRouter();
  const pathname = usePathname();
  const navigationSearchParams = useSearchParams();
  const searchParams = moduleSearchParams ?? navigationSearchParams;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<KnowledgeView>(
    searchParams.get("view") === "documents" ? "documents" : "knowledge",
  );
  const [editMode, setEditMode] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editTags, setEditTags] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createParentId, setCreateParentId] = useState<string | null>(null);
  const [createTitle, setCreateTitle] = useState("");
  const [createAssignmentMode, setCreateAssignmentMode] = useState<KnowledgeAssignmentMode>("all_agents");
  const [createAssignedEmployeeNames, setCreateAssignedEmployeeNames] = useState<string[]>([]);
  const [showImportModal, setShowImportModal] = useState(false);
  const [pendingDocumentForKnowledge, setPendingDocumentForKnowledge] = useState<KnowledgeDocumentPageRecord | null>(null);
  const [documentAssignmentMode, setDocumentAssignmentMode] = useState<KnowledgeAssignmentMode>("all_agents");
  const [documentAssignedEmployeeNames, setDocumentAssignedEmployeeNames] = useState<string[]>([]);
  const [documentSearch, setDocumentSearch] = useState("");
  const [documentTypeFilter, setDocumentTypeFilter] = useState<"all" | "channelDocument" | "markdown" | "nonMarkdown">("all");
  const [documentLinkFilter, setDocumentLinkFilter] = useState<"all" | "linked" | "unlinked">("all");
  const [documentChannelFilter, setDocumentChannelFilter] = useState<string>("all");
  const [documentUploaderFilter, setDocumentUploaderFilter] = useState<string>("all");
  const [documentTimeSort, setDocumentTimeSort] = useState<"newest" | "oldest">("newest");
  const [knowledgeAgentFilter, setKnowledgeAgentFilter] = useState<string>("all");
  const [knowledgeModeFilter, setKnowledgeModeFilter] = useState<"all" | KnowledgeAssignmentMode>("all");
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");
  const [isPending, startTransition] = useTransition();
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const knowledgeUploadInputRef = useRef<HTMLInputElement>(null);
  const documentsUploadInputRef = useRef<HTMLInputElement>(null);
  const parseTasks = data.parseTasks ?? [];
  const hasActiveParseTasks = parseTasks.some((task) => task.status === "running" || task.status === "pending" || task.status === "approved");
  const agentOptions = data.agentOptions ?? [];
  const assignmentStats = data.assignmentStats ?? {
    allAgentsPageCount: data.pages.filter((page) => page.assignmentMode !== "selected_agents").length,
    selectedAgentsPageCount: data.pages.filter((page) => page.assignmentMode === "selected_agents").length,
    unconfiguredPageCount: 0,
  };

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia("(max-width: 860px)");
    const handleChange = (event?: MediaQueryListEvent): void => {
      setIsCompactLayout(event ? event.matches : mediaQuery.matches);
    };

    handleChange();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }

    mediaQuery.addListener(handleChange);
    return () => mediaQuery.removeListener(handleChange);
  }, []);

  useEffect(() => {
    setActiveView(searchParams.get("view") === "documents" ? "documents" : "knowledge");
  }, [searchParams]);

  useEffect(() => {
    if (searchParams.get("create") !== "page" || showCreateModal) {
      return;
    }

    const assignedEmployeeName = searchParams.get("assign")?.trim();
    const canPreassign = Boolean(
      assignedEmployeeName && agentOptions.some((agent) => agent.employeeName === assignedEmployeeName),
    );
    setActiveView("knowledge");
    setCreateParentId(null);
    setCreateTitle("");
    setCreateAssignmentMode(canPreassign ? "selected_agents" : "all_agents");
    setCreateAssignedEmployeeNames(canPreassign && assignedEmployeeName ? [assignedEmployeeName] : []);
    setShowCreateModal(true);

    const nextParams = new URLSearchParams(searchParams.toString());
    nextParams.delete("create");
    nextParams.delete("assign");
    const nextQuery = nextParams.toString();
    if (moduleSearchParams && typeof window !== "undefined") {
      const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`;
      window.history.replaceState(window.history.state, "", nextUrl);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
      return;
    }
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  }, [agentOptions, moduleSearchParams, pathname, router, searchParams, showCreateModal]);

  const selected = data.pages.find((page) => page.id === selectedId) ?? null;
  const documentChannelOptions = Array.from(
    new Set(data.documentPages.map((document) => document.channelName).filter((channelName): channelName is string => Boolean(channelName))),
  ).sort((left, right) => left.localeCompare(right, "zh-CN", { sensitivity: "base" }));
  const documentUploaderOptions = Array.from(
    new Set(data.documentPages.map((document) => document.sourceSpeaker || document.updatedBy).filter(Boolean)),
  ).sort((left, right) => left.localeCompare(right, "zh-CN", { sensitivity: "base" }));
  const filteredDocuments = data.documentPages
    .filter((document) => {
      const query = documentSearch.trim().toLocaleLowerCase("zh-CN");
      if (!query) {
        return true;
      }
      const haystack = [
        document.title,
        document.summary,
        document.fileName,
        document.channelName,
        document.sourceSpeaker,
        document.mediaType,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("zh-CN");
      return haystack.includes(query);
    })
    .filter((document) => {
      if (documentTypeFilter === "all") {
        return true;
      }
      if (documentTypeFilter === "channelDocument") {
        return document.sourceType === "channelDocument";
      }
      if (documentTypeFilter === "markdown") {
        return document.isMarkdown;
      }
      return !document.isMarkdown;
    })
    .filter((document) => {
      if (documentLinkFilter === "all") {
        return true;
      }
      if (documentLinkFilter === "linked") {
        return document.linkedKnowledgePages.length > 0;
      }
      return document.linkedKnowledgePages.length === 0;
    })
    .filter((document) => documentChannelFilter === "all" || document.channelName === documentChannelFilter)
    .filter((document) => documentUploaderFilter === "all" || (document.sourceSpeaker || document.updatedBy) === documentUploaderFilter)
    .sort((left, right) => {
      const multiplier = documentTimeSort === "newest" ? -1 : 1;
      const leftTime = new Date(left.updatedAt || left.sourceTime || 0).getTime();
      const rightTime = new Date(right.updatedAt || right.sourceTime || 0).getTime();
      if (leftTime !== rightTime) {
        return (leftTime - rightTime) * multiplier;
      }
      return left.title.localeCompare(right.title, "zh-CN", { sensitivity: "base" });
    });
  const selectedDocument = data.documentPages.find((document) => document.id === selectedDocumentId) ?? null;

  useEffect(() => {
    if (!isCompactLayout) {
      setMobilePane("list");
      return;
    }

    if (activeView === "knowledge" && !selected) {
      setMobilePane("list");
      return;
    }

    if (activeView === "documents" && !selectedDocument) {
      setMobilePane("list");
    }
  }, [activeView, isCompactLayout, selected, selectedDocument]);

  useEffect(() => {
    if (activeView !== "documents") {
      return;
    }

    const focusedDocumentId = searchParams.get("document");
    const nextDocumentId =
      (focusedDocumentId && data.documentPages.some((document) => document.id === focusedDocumentId) ? focusedDocumentId : null)
      ?? (selectedDocumentId && data.documentPages.some((document) => document.id === selectedDocumentId) ? selectedDocumentId : null)
      ?? filteredDocuments[0]?.id
      ?? data.documentPages[0]?.id
      ?? null;

    if (nextDocumentId !== selectedDocumentId) {
      setSelectedDocumentId(nextDocumentId);
    }
  }, [activeView, data.documentPages, filteredDocuments, searchParams, selectedDocumentId]);

  useEffect(() => {
    if (activeView !== "knowledge") {
      return;
    }

    const focusedPageId = searchParams.get("page");
    if (!focusedPageId || !data.pages.some((page) => page.id === focusedPageId)) {
      return;
    }

    if (focusedPageId !== selectedId) {
      setSelectedId(focusedPageId);
      setEditMode(false);
    }
    if (isCompactLayout) {
      setMobilePane("detail");
    }
  }, [activeView, data.pages, isCompactLayout, searchParams, selectedId]);

  // 解析任务进行中时 2.5s 轮询数据（与市场页 capability_request 节奏一致）
  useEffect(() => {
    if (!hasActiveParseTasks) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      refreshWorkspaceModule(onDataChanged, router);
    }, 2_500);
    return () => window.clearTimeout(timeoutId);
  }, [hasActiveParseTasks, onDataChanged, parseTasks, router]);

  function updateLocation(nextView: KnowledgeView, documentId?: string | null): void {
    const params = new URLSearchParams(searchParams.toString());
    if (nextView === "documents") {
      params.set("view", "documents");
    } else {
      params.delete("view");
      params.delete("document");
    }

    if (nextView === "documents" && documentId) {
      params.set("document", documentId);
    } else if (nextView === "documents") {
      params.delete("document");
    }

    const nextQuery = params.toString();
    if (moduleSearchParams && typeof window !== "undefined") {
      const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}`;
      window.history.replaceState(window.history.state, "", nextUrl);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
      return;
    }
    router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname);
  }

  function openPage(page: KnowledgePage): void {
    setSelectedId(page.id);
    setEditMode(false);
    setEditTitle(page.title);
    setEditContent(page.contentMarkdown);
    setEditTags(page.tags.join(", "));
    if (isCompactLayout) {
      setMobilePane("detail");
    }
  }

  function openDocument(document: KnowledgeDocumentPageRecord): void {
    setSelectedDocumentId(document.id);
    setActiveView("documents");
    updateLocation("documents", document.id);
    if (isCompactLayout) {
      setMobilePane("detail");
    }
  }

  function startEdit(): void {
    if (!selected) {
      return;
    }
    setEditTitle(selected.title);
    setEditContent(selected.contentMarkdown);
    setEditTags(selected.tags.join(", "));
    setEditMode(true);
  }

  function saveEdit(): void {
    if (!selected) {
      return;
    }
    startTransition(async () => {
      await updateKnowledgePageAction(selected.id, {
        title: editTitle.trim() || selected.title,
        contentMarkdown: editContent,
        tags: editTags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      setEditMode(false);
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function saveAssignments(page: KnowledgePageRecord, assignmentMode: KnowledgeAssignmentMode, assignedEmployeeNames: string[]): void {
    startTransition(async () => {
      await setKnowledgePageAssignmentsAction({
        pageId: page.id,
        assignmentMode,
        assignedEmployeeNames,
      });
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleUploadFile(file: File, intent: "auto_deposit" | "document_only"): void {
    setUploadError(null);
    setIsUploading(true);
    const workspaceId = data.workspaceId;
    if (!workspaceId) {
      setUploadError(tx("当前工作区信息缺失，请刷新页面后重试。", "Workspace context is missing. Refresh and try again."));
      setIsUploading(false);
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    formData.append("intent", intent);
    void (async () => {
      try {
        const response = await fetch(`/api/workspaces/${workspaceId}/knowledge/upload`, {
          method: "POST",
          body: formData,
        });
        if (!response.ok) {
          const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(errorPayload?.error ?? `Upload failed: ${response.status}`);
        }
        refreshWorkspaceModule(onDataChanged, router);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Upload failed.";
        setUploadError(message);
      } finally {
        setIsUploading(false);
      }
    })();
  }

  function openCreateModal(parentId: string | null): void {
    setCreateParentId(parentId);
    setCreateTitle("");
    setCreateAssignmentMode("all_agents");
    setCreateAssignedEmployeeNames([]);
    setShowCreateModal(true);
  }

  function handleCreate(): void {
    if (!createTitle.trim()) {
      return;
    }
    startTransition(async () => {
      await createKnowledgePageAction({
        title: createTitle.trim(),
        parentId: createParentId,
        assignmentMode: createAssignmentMode,
        assignedEmployeeNames: createAssignmentMode === "selected_agents" ? createAssignedEmployeeNames : [],
      });
      setShowCreateModal(false);
      setCreateTitle("");
      setCreateParentId(null);
      setCreateAssignmentMode("all_agents");
      setCreateAssignedEmployeeNames([]);
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleDelete(id: string): void {
    startTransition(async () => {
      await deleteKnowledgePageAction(id);
      if (selectedId === id) {
        setSelectedId(null);
        setEditMode(false);
      }
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleImportMaterial(materialId: string): void {
    startTransition(async () => {
      await materialToKnowledgePageAction(materialId);
      setShowImportModal(false);
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleCreateKnowledgeFromDocument(document: KnowledgeDocumentPageRecord): void {
    setPendingDocumentForKnowledge(document);
    setDocumentAssignmentMode("all_agents");
    setDocumentAssignedEmployeeNames([]);
  }

  function confirmCreateKnowledgeFromDocument(): void {
    if (!pendingDocumentForKnowledge) {
      return;
    }
    const document = pendingDocumentForKnowledge;
    startTransition(async () => {
      const pageId = await createKnowledgePageFromDocumentAction({
        sourceType: document.sourceType,
        sourceId: document.sourceId,
        assignmentMode: documentAssignmentMode,
        assignedEmployeeNames: documentAssignmentMode === "selected_agents" ? documentAssignedEmployeeNames : [],
      });
      setPendingDocumentForKnowledge(null);
      setDocumentAssignmentMode("all_agents");
      setDocumentAssignedEmployeeNames([]);
      setSelectedId(pageId);
      setEditMode(false);
      setActiveView("knowledge");
      updateLocation("knowledge");
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function handleCreateChannelDocumentFromAttachment(document: KnowledgeDocumentPageRecord): void {
    if (document.sourceType !== "attachment" || !document.channelName) {
      return;
    }
    const channelName = document.channelName;
    startTransition(async () => {
      const result = await createChannelDocumentFromAttachmentAction({
        channelName,
        attachmentId: document.sourceId,
        title: document.fileName.replace(/\.md$/i, ""),
      });
      setActiveView("documents");
      updateLocation("documents", `channelDocument:${result.documentId}`);
      refreshWorkspaceModule(onDataChanged, router);
    });
  }

  function openLinkedKnowledgePage(pageId: string): void {
    const page = data.pages.find((candidate) => candidate.id === pageId);
    setActiveView("knowledge");
    updateLocation("knowledge");
    if (page) {
      openPage(page);
      return;
    }
    setSelectedId(pageId);
  }

  function openDocumentPage(documentId: string): void {
    const document = data.documentPages.find((candidate) => candidate.id === documentId);
    if (document) {
      openDocument(document);
      return;
    }
    setActiveView("documents");
    updateLocation("documents", documentId);
  }

  const filteredKnowledgePages = data.pages
    .filter((page) => knowledgeModeFilter === "all" || page.assignmentMode === knowledgeModeFilter)
    .filter((page) => {
      if (knowledgeAgentFilter === "all") {
        return true;
      }
      if (page.assignmentMode === "all_agents") {
        return true;
      }
      return (page.assignedEmployeeNames ?? []).includes(knowledgeAgentFilter);
    });
  const rootPages = filteredKnowledgePages
    .filter((page) => page.parentId === null)
    .sort((left, right) => left.sortOrder - right.sortOrder);
  const showListPane = !isCompactLayout || mobilePane === "list";
  const showDetailPane = !isCompactLayout || mobilePane === "detail";
  const currentMobileTitle = activeView === "knowledge" ? selected?.title : selectedDocument?.title;
  const currentMobileSubtitle =
    activeView === "knowledge"
      ? editMode
        ? tx("编辑页面", "Editing page")
        : tx("知识页面", "Knowledge page")
      : tx("文档页面", "Document page");
  return (
    <WorkbenchPageFrame className="knowledge-page" density="full-bleed">
      <WorkbenchPageHeader
        actions={(
          <div aria-label={tx("知识库视图", "Knowledge views")} className="container-view-switch" role="tablist">
            <button
              aria-selected={activeView === "knowledge"}
              className={`container-view-switch__item${activeView === "knowledge" ? " container-view-switch__item--active" : ""}`}
              disabled={activeView === "knowledge"}
              onClick={() => {
                setActiveView("knowledge");
                setMobilePane("list");
                updateLocation("knowledge");
              }}
              role="tab"
              type="button"
            >
              {tx("知识页面", "Knowledge")}
            </button>
            <button
              aria-selected={activeView === "documents"}
              className={`container-view-switch__item${activeView === "documents" ? " container-view-switch__item--active" : ""}`}
              disabled={activeView === "documents"}
              onClick={() => {
                setActiveView("documents");
                setMobilePane("list");
                updateLocation("documents");
              }}
              role="tab"
              type="button"
            >
              {tx("文档页面", "Documents")}
            </button>
          </div>
        )}
        description={tx("沉淀团队可复用的信息，并明确每一页的共享范围与负责 AI员工。", "Capture reusable team knowledge and make each page's sharing scope and assigned AI employees explicit.")}
        eyebrow={tx("资源", "Resources")}
        meta={(
          <>
            <span>{tx(`${data.totalCount} 个知识页`, `${data.totalCount} knowledge pages`)}</span>
            <span>{tx(`${assignmentStats.allAgentsPageCount} 个全员共享`, `${assignmentStats.allAgentsPageCount} shared`)}</span>
            <span>{tx(`${data.documentPages.length} 个文档`, `${data.documentPages.length} documents`)}</span>
          </>
        )}
        title={tx("知识库", "Knowledge base")}
      />
      <div className={`knowledge-layout${isCompactLayout ? " knowledge-layout--compact" : ""}`}>
      {showListPane ? (
        <div className="knowledge-sidebar">
          {activeView === "knowledge" ? (
            <>
              <div className="knowledge-sidebar__header">
                <h2>{tx("知识页面", "Knowledge pages")}</h2>
                <div className="knowledge-sidebar__actions">
                  <button
                    aria-label={tx("新建顶层知识页面", "Create top-level knowledge page")}
                    className="knowledge-btn knowledge-btn--primary"
                    onClick={() => openCreateModal(null)}
                    type="button"
                  >
                    <AppIcon name="plus" />
                  </button>
                  <button
                    aria-label={tx("上传文件到知识库", "Upload file to knowledge base")}
                    className="knowledge-btn knowledge-btn--ghost"
                    disabled={isUploading}
                    onClick={() => knowledgeUploadInputRef.current?.click()}
                    type="button"
                  >
                    <AppIcon name="upload" />
                  </button>
                  <input
                    accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/markdown,text/plain,.md,.txt,.pdf,.docx,.pptx,.xlsx"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        handleUploadFile(file, "auto_deposit");
                      }
                      event.target.value = "";
                    }}
                    ref={knowledgeUploadInputRef}
                    type="file"
                  />
                  {data.materials.length > 0 ? (
                    <button
                      className="knowledge-btn knowledge-btn--ghost"
                      onClick={() => setShowImportModal(true)}
                      type="button"
                    >
                      {tx("导入", "Import")}
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="knowledge-sidebar__count">
                {tx(
                  `${data.totalCount} 个页面 · ${assignmentStats.allAgentsPageCount} 个全员共享`,
                  `${data.totalCount} pages · ${assignmentStats.allAgentsPageCount} shared`,
                )}
              </div>

              <div className="knowledge-documents__filter-grid knowledge-filter-bar">
                <select
                  aria-label={tx("筛选知识范围", "Filter knowledge scope")}
                  className="knowledge-documents__select"
                  onChange={(event) => setKnowledgeModeFilter(event.target.value as "all" | KnowledgeAssignmentMode)}
                  value={knowledgeModeFilter}
                >
                  <option value="all">{tx("全部范围", "All scopes")}</option>
                  <option value="all_agents">{tx("全员共享", "Shared")}</option>
                  <option value="selected_agents">{tx("指定 AI员工", "Selected AI employees")}</option>
                </select>
                <select
                  aria-label={tx("筛选 AI员工", "Filter AI employee")}
                  className="knowledge-documents__select"
                  onChange={(event) => setKnowledgeAgentFilter(event.target.value)}
                  value={knowledgeAgentFilter}
                >
                  <option value="all">{tx("全部 AI员工", "All AI employees")}</option>
                  {agentOptions.map((agent) => (
                    <option key={agent.employeeName} value={agent.employeeName}>
                      {agent.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="knowledge-tree">
                {rootPages.length > 0 ? (
                  rootPages.map((page) => (
                    <KnowledgeTreeNode
                      key={page.id}
                      page={page}
                      allPages={filteredKnowledgePages}
                      selectedId={selectedId}
                      depth={0}
                      onSelect={openPage}
                      onAddChild={(parentId) => {
                        openCreateModal(parentId);
                      }}
                    />
                  ))
                ) : (
                  <EmptyState
                    actionLabel={tx("创建知识页面", "Create knowledge page")}
                    body={tx("还没有知识页面。先创建第一篇长期沉淀内容。", "There are no knowledge pages yet. Start by creating the first long-lived page.")}
                    eyebrow={tx("知识页面", "Knowledge pages")}
                    onAction={() => openCreateModal(null)}
                    title={tx("知识页为空", "No knowledge pages yet")}
                    variant="warm"
                  />
                )}
              </div>
            </>
          ) : (
            <>
              <div className="knowledge-sidebar__header knowledge-sidebar__header--stacked">
                <div>
                  <h2>{tx("文档页面", "Document pages")}</h2>
                  <p className="knowledge-sidebar__subtle">
                    {tx(
                      `${data.linkedDocumentCount} 个文档已沉淀为知识页面`,
                      `${data.linkedDocumentCount} document(s) already linked to knowledge pages`,
                    )}
                  </p>
                </div>
                <div className="knowledge-sidebar__actions">
                  <button
                    aria-label={tx("上传文件到文档页面", "Upload file to documents page")}
                    className="knowledge-btn knowledge-btn--primary"
                    disabled={isUploading}
                    onClick={() => documentsUploadInputRef.current?.click()}
                    type="button"
                  >
                    <AppIcon name="upload" />
                    {tx("上传", "Upload")}
                  </button>
                  <input
                    accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/markdown,text/plain,.md,.txt,.pdf,.docx,.pptx,.xlsx"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        handleUploadFile(file, "document_only");
                      }
                      event.target.value = "";
                    }}
                    ref={documentsUploadInputRef}
                    type="file"
                  />
                </div>
              </div>

              <div className="knowledge-sidebar__count">
                {tx(
                  "当前用户可见的共享文档索引",
                  "Shared documents visible to the current user",
                )}
              </div>

              <div className="knowledge-documents__filters">
                <input
                  aria-label={tx("搜索文档", "Search documents")}
                  className="knowledge-documents__search"
                  onChange={(event) => setDocumentSearch(event.target.value)}
                  placeholder={tx("搜索文档、来源或类型", "Search documents, source, or type")}
                  value={documentSearch}
                />
                <div className="knowledge-documents__filter-grid">
                  <select aria-label={tx("筛选群组", "Filter channel")} className="knowledge-documents__select" onChange={(event) => setDocumentChannelFilter(event.target.value)} value={documentChannelFilter}>
                    <option value="all">{tx("全部群组", "All channels")}</option>
                    {documentChannelOptions.map((channelName) => (
                      <option key={channelName} value={channelName}>
                        {channelName}
                      </option>
                    ))}
                  </select>
                  <select aria-label={tx("筛选上传人", "Filter uploader")} className="knowledge-documents__select" onChange={(event) => setDocumentUploaderFilter(event.target.value)} value={documentUploaderFilter}>
                    <option value="all">{tx("全部上传人", "All uploaders")}</option>
                    {documentUploaderOptions.map((uploader) => (
                      <option key={uploader} value={uploader}>
                        {translateSystemSpeaker(uploader, tx)}
                      </option>
                    ))}
                  </select>
                  <select aria-label={tx("筛选文档类型", "Filter document type")} className="knowledge-documents__select" onChange={(event) => setDocumentTypeFilter(event.target.value as "all" | "channelDocument" | "markdown" | "nonMarkdown")} value={documentTypeFilter}>
                    <option value="all">{tx("全部类型", "All types")}</option>
                    <option value="channelDocument">{tx("共享文档", "Shared documents")}</option>
                    <option value="markdown">{tx("Markdown", "Markdown")}</option>
                    <option value="nonMarkdown">{tx("非 Markdown", "Non-Markdown")}</option>
                  </select>
                  <select aria-label={tx("筛选沉淀状态", "Filter linkage status")} className="knowledge-documents__select" onChange={(event) => setDocumentLinkFilter(event.target.value as "all" | "linked" | "unlinked")} value={documentLinkFilter}>
                    <option value="all">{tx("全部沉淀状态", "All linkage")}</option>
                    <option value="linked">{tx("已沉淀为知识页", "Linked to knowledge")}</option>
                    <option value="unlinked">{tx("未沉淀", "Unlinked")}</option>
                  </select>
                  <select aria-label={tx("文档排序", "Sort documents")} className="knowledge-documents__select" onChange={(event) => setDocumentTimeSort(event.target.value as "newest" | "oldest")} value={documentTimeSort}>
                    <option value="newest">{tx("最新优先", "Newest first")}</option>
                    <option value="oldest">{tx("最早优先", "Oldest first")}</option>
                  </select>
                </div>
              </div>

              <div className="knowledge-documents">
                {filteredDocuments.length > 0 ? (
                  filteredDocuments.map((document) => (
                    <button
                      className={`knowledge-document-item${selectedDocumentId === document.id ? " knowledge-document-item--selected" : ""}`}
                      key={document.id}
                      onClick={() => openDocument(document)}
                      type="button"
                    >
                      <strong>{document.title}</strong>
                      <span>{document.summary}</span>
                      <small>
                        {[
                          document.channelName ? `#${document.channelName}` : null,
                          translateSystemSpeaker(document.updatedBy, tx) || tx("未知用户", "Unknown actor"),
                          formatKnowledgeTime(document.updatedAt || document.sourceTime),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                      <div className="knowledge-document-item__badges">
                        <span className="knowledge-tag">{document.isMarkdown ? "MD" : document.mediaType}</span>
                        {document.linkedKnowledgePages.length > 0 ? (
                          <span className="knowledge-tag">{tx("已沉淀", "Linked")}</span>
                        ) : null}
                      </div>
                    </button>
                  ))
                ) : (
                  <EmptyState
                    body={tx("试试放宽筛选条件，或者先在频道里发送共享文档。", "Try loosening the filters, or send a shared document from a channel first.")}
                    eyebrow={tx("文档页面", "Document pages")}
                    title={tx("没有匹配文档", "No matching documents")}
                  />
                )}
              </div>
            </>
          )}
        </div>
      ) : null}

      {showDetailPane ? (
        <div className="knowledge-content">
          {isCompactLayout && currentMobileTitle ? (
            <div className="knowledge-mobile-bar">
              <button
                aria-label={tx("返回列表", "Back to list")}
                className="knowledge-mobile-bar__back"
                onClick={() => setMobilePane("list")}
                type="button"
              >
                <AppIcon name="arrowLeft" />
              </button>
              <div className="knowledge-mobile-bar__copy">
                <strong>{currentMobileTitle}</strong>
                <span>{currentMobileSubtitle}</span>
              </div>
            </div>
          ) : null}

          {(parseTasks.length > 0 || uploadError || isUploading) ? (
            <ParseTaskPanel
              isUploading={isUploading}
              parseTasks={parseTasks}
              uploadError={uploadError}
              onSelectPage={openPage}
            />
          ) : null}

          {activeView === "knowledge" ? (
            selected ? (
              editMode ? (
                <div className="knowledge-editor">
                  <div className="knowledge-editor__toolbar">
                    <input
                      className="knowledge-editor__title-input"
                      onChange={(event) => setEditTitle(event.target.value)}
                      placeholder={tx("页面标题", "Page title")}
                      value={editTitle}
                    />
                    <div className="knowledge-editor__btns">
                      <button
                        className="knowledge-btn knowledge-btn--primary"
                        disabled={isPending}
                        onClick={saveEdit}
                        type="button"
                      >
                        {tx("保存", "Save")}
                      </button>
                      <button
                        className="knowledge-btn knowledge-btn--ghost"
                        onClick={() => setEditMode(false)}
                        type="button"
                      >
                        {tx("取消", "Cancel")}
                      </button>
                    </div>
                  </div>
                  <div className="knowledge-editor__tags">
                    <label>{tx("标签", "Tags")}</label>
                    <input
                      onChange={(event) => setEditTags(event.target.value)}
                      placeholder={tx("逗号分隔", "Comma separated")}
                      value={editTags}
                    />
                  </div>
                  <div className="knowledge-editor__md-container" data-color-mode="light">
                    <MDEditor
                      commands={commands.getCommands()}
                      height="100%"
                      onChange={(value) => setEditContent(value ?? "")}
                      preview="live"
                      value={editContent}
                      visibleDragbar={false}
                    />
                  </div>
                </div>
              ) : (
                <div className="knowledge-viewer">
                  <div className="knowledge-viewer__header">
                    <h1>{selected.title}</h1>
                    <div className="knowledge-viewer__actions">
                      <button
                        className="knowledge-btn knowledge-btn--primary"
                        onClick={startEdit}
                        type="button"
                      >
                        {tx("编辑", "Edit")}
                      </button>
                      <button
                        className="knowledge-btn knowledge-btn--danger"
                        disabled={isPending}
                        onClick={() => handleDelete(selected.id)}
                        type="button"
                      >
                        {tx("删除", "Delete")}
                      </button>
                    </div>
                  </div>
                  {selected.tags.length > 0 ? (
                    <div className="knowledge-viewer__tags">
                      {selected.tags.map((tag) => (
                        <span className="knowledge-tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <div className="knowledge-viewer__meta">
                    {tx("创建者", "Created by")}: {translateSystemSpeaker(selected.createdBy, tx) || "—"} · {tx("更新于", "Updated")}:{" "}
                    {formatKnowledgeTime(selected.updatedAt)}
                  </div>
                  {selected.sourceKnowledgeProposalId || selected.sourceTaskQueueId || selected.sourceAgentName ? (
                    <div className="knowledge-viewer__meta knowledge-viewer__meta--source">
                      {tx("来源", "Source")}:{" "}
                      {[
                        selected.sourceAgentName ? tx(`AI员工 ${selected.sourceAgentName}`, `AI employee ${selected.sourceAgentName}`) : "",
                        selected.sourceTaskQueueId ? tx(`任务 ${selected.sourceTaskQueueId}`, `Task ${selected.sourceTaskQueueId}`) : "",
                        selected.sourceKnowledgeProposalId ? tx(`审批候选 ${selected.sourceKnowledgeProposalId}`, `Proposal ${selected.sourceKnowledgeProposalId}`) : "",
                        selected.sourceApprovalId ? tx(`审批 ${selected.sourceApprovalId}`, `Approval ${selected.sourceApprovalId}`) : "",
                      ].filter(Boolean).join(" · ")}
                    </div>
                  ) : null}
                  <KnowledgeAssignmentPanel
                    agents={agentOptions}
                    page={selected}
                    pending={isPending}
                    onSave={(assignmentMode, assignedEmployeeNames) => saveAssignments(selected, assignmentMode, assignedEmployeeNames)}
                  />
                  <div className="knowledge-viewer__body">
                    {selected.contentMarkdown ? (
                      <div className="knowledge-viewer__md-container" data-color-mode="light">
                        <MDEditor.Markdown
                          source={selected.contentMarkdown}
                          style={{ minHeight: 120, padding: "16px 20px", background: "transparent" }}
                        />
                      </div>
                    ) : (
                      <p className="knowledge-viewer__empty">
                        {tx("页面内容为空，点击编辑添加内容。", "Empty page. Click Edit to add content.")}
                      </p>
                    )}
                  </div>
                </div>
              )
            ) : (
              <EmptyState
                body={tx("从左侧选择一个页面，或者新建一篇长期知识页。", "Select a page from the left, or create a new long-lived knowledge page.")}
                eyebrow={tx("知识页面", "Knowledge pages")}
                title={tx("等待选择页面", "Choose a page")}
                variant="cool"
              />
            )
          ) : selectedDocument ? (
            <DocumentPageViewer
              document={selectedDocument}
              isPending={isPending}
              onCreateChannelDocument={handleCreateChannelDocumentFromAttachment}
              onOpenDocumentPage={openDocumentPage}
              onCreateKnowledgePage={handleCreateKnowledgeFromDocument}
              onOpenLinkedKnowledgePage={openLinkedKnowledgePage}
              workspaceId={data.workspaceId}
              tx={tx}
            />
          ) : (
            <EmptyState
              body={tx("从左侧选择一个共享文档，查看来源、沉淀状态与后续操作。", "Select a shared document to inspect its source, linkage state, and next actions.")}
              eyebrow={tx("文档页面", "Document pages")}
              title={tx("等待选择文档", "Choose a document")}
              variant="cool"
            />
          )}
        </div>
      ) : null}

      {showCreateModal ? (
        <div className="knowledge-modal-overlay" onClick={() => setShowCreateModal(false)}>
          <div className="knowledge-modal" onClick={(event) => event.stopPropagation()}>
            <h3>{tx("新建知识页面", "New Knowledge Page")}</h3>
            {createParentId ? (
              <p className="knowledge-modal__hint">
                {tx("父页面", "Parent")}: {data.pages.find((page) => page.id === createParentId)?.title ?? createParentId}
              </p>
            ) : null}
            <input
              autoFocus
              className="knowledge-modal__input"
              onChange={(event) => setCreateTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  handleCreate();
                }
              }}
              placeholder={tx("页面标题", "Page title")}
              value={createTitle}
            />
            <KnowledgeAssignmentDraftControls
              agents={agentOptions}
              mode={createAssignmentMode}
              selectedEmployeeNames={createAssignedEmployeeNames}
              onModeChange={setCreateAssignmentMode}
              onToggleEmployee={(employeeName) => {
                setCreateAssignedEmployeeNames((current) => toggleEmployeeSelection(current, employeeName));
              }}
            />
            <div className="knowledge-modal__footer">
              <button
                className="knowledge-btn knowledge-btn--primary"
                disabled={isPending || !createTitle.trim()}
                onClick={handleCreate}
                type="button"
              >
                {tx("创建", "Create")}
              </button>
              <button
                className="knowledge-btn knowledge-btn--ghost"
                onClick={() => setShowCreateModal(false)}
                type="button"
              >
                {tx("取消", "Cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showImportModal ? (
        <div className="knowledge-modal-overlay" onClick={() => setShowImportModal(false)}>
          <div className="knowledge-modal" onClick={(event) => event.stopPropagation()}>
            <h3>{tx("从素材导入", "Import from Material")}</h3>
            <div className="knowledge-import-list">
              {data.materials.map((material) => (
                <button
                  className="knowledge-import-item"
                  key={material.id}
                  disabled={isPending}
                  onClick={() => handleImportMaterial(material.id)}
                  type="button"
                >
                  <strong>{material.source}</strong>
                  {material.preview ? <span>{material.preview.slice(0, 80)}</span> : null}
                </button>
              ))}
            </div>
            <div className="knowledge-modal__footer">
              <button
                className="knowledge-btn knowledge-btn--ghost"
                onClick={() => setShowImportModal(false)}
                type="button"
              >
                {tx("关闭", "Close")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingDocumentForKnowledge ? (
        <div className="knowledge-modal-overlay" onClick={() => setPendingDocumentForKnowledge(null)}>
          <div className="knowledge-modal" onClick={(event) => event.stopPropagation()}>
            <h3>{tx("沉淀为知识页面", "Create knowledge page")}</h3>
            <p className="knowledge-modal__hint">
              {pendingDocumentForKnowledge.title}
            </p>
            <KnowledgeAssignmentDraftControls
              agents={agentOptions}
              mode={documentAssignmentMode}
              selectedEmployeeNames={documentAssignedEmployeeNames}
              onModeChange={setDocumentAssignmentMode}
              onToggleEmployee={(employeeName) => {
                setDocumentAssignedEmployeeNames((current) => toggleEmployeeSelection(current, employeeName));
              }}
            />
            <div className="knowledge-modal__footer">
              <button
                className="knowledge-btn knowledge-btn--primary"
                disabled={isPending}
                onClick={confirmCreateKnowledgeFromDocument}
                type="button"
              >
                {tx("创建知识页面", "Create knowledge page")}
              </button>
              <button
                className="knowledge-btn knowledge-btn--ghost"
                onClick={() => setPendingDocumentForKnowledge(null)}
                type="button"
              >
                {tx("取消", "Cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      </div>
    </WorkbenchPageFrame>
  );
}

function formatKnowledgeTime(value?: string): string {
  return formatCompactTimestamp(value, { emptyFallback: "—" });
}
