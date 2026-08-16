"use client";

// 会话外壳组件（3.4-2 拆分后仅保留组件本体）：
// 线程数据模型/纯函数在 ./conversation-thread，滚动锚点在 ./conversation-scroll-anchors。
// 公共导入面保持不变——外部仍从本模块导入类型与 orderConversationMessages。

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChatComposer, ChatEmptyState, ChatHeader, ConversationListRow, ConversationMessageBubble } from "@/features/chat/chat-primitives";
import { applyMentionSelection, findDraftMentionQuery } from "@dofe-agent/domain";
import { useLanguage } from "@/features/i18n/language-provider";
import { translateSystemSpeaker } from "@/features/i18n/presentation";
import { AppIcon } from "@/shared/ui/app-icon";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import { useResizablePane } from "@/shared/lib/use-resizable-pane";
import { PaneResizeHandle } from "@/shared/ui/pane-resize-handle";
import type { GeneratedAvatarVariant } from "@/shared/ui/generated-avatar";
import type { EmployeeExecutionPolicy } from "@dofe-agent/domain/workspace";
import type {
  ConversationComposerRuntime,
  ConversationListItem,
  ConversationMentionCandidate,
  ConversationSlashCommand,
  ConversationThreadMessage,
  OptimisticConversationMessage,
  QueuedConversationMessage,
  SelectedComposerReference,
} from "@/features/chat/conversation-thread";
import {
  buildComposerSlashCommands,
  buildReplyMentionPrefix,
  findDraftSlashQuery,
  hasServerMessageCopy,
  isOwnHumanMessage,
  orderConversationMessages,
  policyForSlashCommand,
  replaceDraftRange,
  resolveSubmittedSlashCommand,
} from "@/features/chat/conversation-thread";
import type { ConversationScrollAnchor } from "@/features/chat/conversation-scroll-anchors";
import {
  buildConversationScrollAnchor,
  pruneConversationScrollAnchors,
  readConversationScrollAnchors,
  restoreConversationScrollAnchor,
  writeConversationScrollAnchors,
} from "@/features/chat/conversation-scroll-anchors";

export { orderConversationMessages } from "@/features/chat/conversation-thread";
export type {
  ConversationComposerRuntime,
  ConversationListItem,
  ConversationMentionCandidate,
  ConversationSlashCommand,
  ConversationThreadMessage,
} from "@/features/chat/conversation-thread";

type PendingFile = {
  id: string;
  file: File;
  label: string;
};

export function ConversationShell({
  listKicker,
  listTitle,
  listCount,
  items,
  selectedItemId,
  onSelectItem,
  selectedHeader,
  messages,
  emptyListTitle,
  emptyListBody,
  emptyThreadTitle,
  emptyThreadBody,
  placeholder,
  onSubmit,
  headerActions,
  listActions,
  shellClassName = "",
  customThreadHeader,
  customThreadContent,
  threadAfterMessages,
  threadHasSupplementaryContent = false,
  mentionCandidates = [],
  supplementaryPanel,
  supplementaryPanelTitle,
  onCloseSupplementaryPanel,
  onPinMessage,
  onUnpinMessage,
  onAcknowledgeMessage,
  onReviewApproval,
  currentUserDisplayName,
  draftStorageKey,
  scrollAnchorStorageKey,
  onDataChanged,
  isAgentRunning = false,
  onStopActiveTask,
  composerRuntime,
  onUpdateExecutionPolicy,
  onOpenModelSelector,
}: {
  listKicker: string;
  listTitle: string;
  listCount: number;
  items: ConversationListItem[];
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  selectedHeader:
    | {
        title: string;
        subtitle: string;
        avatar: string;
        avatarId?: string;
        avatarName?: string;
        avatarVariant?: GeneratedAvatarVariant;
      }
    | null;
  messages: ConversationThreadMessage[];
  emptyListTitle: string;
  emptyListBody: string;
  emptyThreadTitle: string;
  emptyThreadBody: string;
  placeholder: string;
  onSubmit: (input: {
    content: string;
    files: File[];
    replyToMessageId?: string;
    referenceAttachmentIds?: string[];
    referenceSkillIds?: string[];
  }) => Promise<void>;
  headerActions?: React.ReactNode;
  listActions?: React.ReactNode;
  shellClassName?: string;
  customThreadHeader?: (input: { backButton: React.ReactNode | null }) => React.ReactNode;
  customThreadContent?: React.ReactNode;
  threadAfterMessages?: React.ReactNode;
  threadHasSupplementaryContent?: boolean;
  mentionCandidates?: ConversationMentionCandidate[];
  supplementaryPanel?: React.ReactNode;
  supplementaryPanelTitle?: string;
  onCloseSupplementaryPanel?: () => void;
  onPinMessage?: (messageId: string) => void;
  onUnpinMessage?: (messageId: string) => void;
  onAcknowledgeMessage?: (messageId: string) => void;
  onReviewApproval?: (approvalId: string, decision: "approved" | "rejected") => Promise<void> | void;
  currentUserDisplayName?: string;
  draftStorageKey?: string;
  scrollAnchorStorageKey?: string;
  onDataChanged?: () => void;
  isAgentRunning?: boolean;
  onStopActiveTask?: () => Promise<void>;
  composerRuntime?: ConversationComposerRuntime;
  onUpdateExecutionPolicy?: (employeeId: string, policy?: EmployeeExecutionPolicy) => Promise<void>;
  onOpenModelSelector?: () => void;
}) {
  const { tx } = useLanguage();
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [draftCaretIndex, setDraftCaretIndex] = useState(0);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [showExecutionPolicyMenu, setShowExecutionPolicyMenu] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [mentionFeedback, setMentionFeedback] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [replyToMessage, setReplyToMessage] = useState<ConversationThreadMessage | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<QueuedConversationMessage[]>([]);
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticConversationMessage[]>([]);
  const [selectedReferences, setSelectedReferences] = useState<SelectedComposerReference[]>([]);
  const [executionPolicyOverride, setExecutionPolicyOverride] = useState<EmployeeExecutionPolicy | null | undefined>(undefined);
  const [isExecutionPolicyPending, setIsExecutionPolicyPending] = useState(false);
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [mobilePane, setMobilePane] = useState<"list" | "thread">("list");
  const listPaneResize = useResizablePane({
    defaultWidth: 340,
    maxWidth: 560,
    minWidth: 300,
    storageKey: "dofe-agent.conversation-list-width",
  });
  const threadViewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const focusComposerRequestRef = useRef<number | null>(null);
  const pendingMessageScrollRef = useRef<OptimisticConversationMessage | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const previousSelectedIdRef = useRef<string | null>(null);
  const threadViewportVisibleRef = useRef(false);
  const scrollAnchorsRef = useRef<Record<string, ConversationScrollAnchor>>({});
  const initialDraftHydratedRef = useRef(false);
  const hydratedQueueKeyRef = useRef<string | null>(null);
  const autoDispatchedQueueIdRef = useRef<string | null>(null);
  const hasCustomThreadContent = customThreadContent !== undefined && customThreadContent !== null;
  const queueStorageKey = draftStorageKey && selectedItemId
    ? `${draftStorageKey}:queue:${selectedItemId}`
    : undefined;
  const serializedExecutionPolicy = JSON.stringify(composerRuntime?.executionPolicy ?? {});

  useEffect(() => {
    setExecutionPolicyOverride(undefined);
    setShowExecutionPolicyMenu(false);
  }, [composerRuntime?.employeeId, composerRuntime?.provider, selectedItemId, serializedExecutionPolicy]);

  useEffect(() => {
    setMentionFeedback(null);
  }, [mentionCandidates.length, selectedItemId]);

  useEffect(() => {
    if (!draftStorageKey || initialDraftHydratedRef.current || typeof window === "undefined") {
      return;
    }
    initialDraftHydratedRef.current = true;
    const raw = window.sessionStorage.getItem(draftStorageKey);
    if (!raw) {
      return;
    }
    try {
      const saved = JSON.parse(raw) as { draft?: unknown; draftCaretIndex?: unknown; references?: unknown };
      if (typeof saved.draft === "string") {
        setDraft(saved.draft);
        setDraftCaretIndex(
          typeof saved.draftCaretIndex === "number"
            ? saved.draftCaretIndex
            : saved.draft.length,
        );
      }
      if (Array.isArray(saved.references)) {
        setSelectedReferences(saved.references.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const value = item as Record<string, unknown>;
          if (
            typeof value.id !== "string" ||
            typeof value.label !== "string" ||
            typeof value.sourceId !== "string" ||
            (value.kind !== "file" && value.kind !== "skill")
          ) {
            return [];
          }
          return [value as unknown as SelectedComposerReference];
        }));
      }
    } catch {
      window.sessionStorage.removeItem(draftStorageKey);
    }
  }, [draftStorageKey]);

  useEffect(() => {
    if (!draftStorageKey || !initialDraftHydratedRef.current || typeof window === "undefined") {
      return;
    }
    if (!draft && pendingFiles.length === 0 && !replyToMessage && selectedReferences.length === 0) {
      window.sessionStorage.removeItem(draftStorageKey);
      return;
    }
    window.sessionStorage.setItem(
      draftStorageKey,
      JSON.stringify({
        draft,
        draftCaretIndex,
        references: selectedReferences,
      }),
    );
  }, [draft, draftCaretIndex, draftStorageKey, pendingFiles.length, replyToMessage, selectedReferences]);

  useEffect(() => {
    if (!queueStorageKey || typeof window === "undefined") {
      hydratedQueueKeyRef.current = null;
      setQueuedMessages([]);
      return;
    }
    hydratedQueueKeyRef.current = queueStorageKey;
    const raw = window.sessionStorage.getItem(queueStorageKey);
    if (!raw) {
      setQueuedMessages([]);
      return;
    }
    try {
      const saved = JSON.parse(raw) as unknown;
      if (!Array.isArray(saved)) {
        throw new Error("Invalid queue");
      }
      setQueuedMessages(saved.flatMap((item) => {
        if (!item || typeof item !== "object") {
          return [];
        }
        const value = item as Record<string, unknown>;
        if (typeof value.id !== "string" || typeof value.content !== "string" || !value.content.trim()) {
          return [];
        }
        return [{
          id: value.id,
          content: value.content,
          replyToMessageId: typeof value.replyToMessageId === "string" ? value.replyToMessageId : undefined,
          createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
          referenceAttachmentIds: Array.isArray(value.referenceAttachmentIds)
            ? value.referenceAttachmentIds.filter((id): id is string => typeof id === "string")
            : undefined,
          referenceSkillIds: Array.isArray(value.referenceSkillIds)
            ? value.referenceSkillIds.filter((id): id is string => typeof id === "string")
            : undefined,
        } satisfies QueuedConversationMessage];
      }));
    } catch {
      window.sessionStorage.removeItem(queueStorageKey);
      setQueuedMessages([]);
    }
  }, [queueStorageKey]);

  useEffect(() => {
    if (
      !queueStorageKey ||
      hydratedQueueKeyRef.current !== queueStorageKey ||
      typeof window === "undefined"
    ) {
      return;
    }
    if (queuedMessages.length === 0) {
      window.sessionStorage.removeItem(queueStorageKey);
      return;
    }
    window.sessionStorage.setItem(queueStorageKey, JSON.stringify(queuedMessages));
  }, [queueStorageKey, queuedMessages]);

  useEffect(() => {
    if (messages.length === 0) {
      return;
    }
    setOptimisticMessages((current) => {
      const next = current.filter((optimisticMessage) => !(
        optimisticMessage.conversationId === selectedItemId &&
        hasServerMessageCopy(optimisticMessage, messages)
      ));
      return next.length === current.length ? current : next;
    });
  }, [messages, selectedItemId]);

  useEffect(() => {
    if (isAgentRunning) {
      autoDispatchedQueueIdRef.current = null;
      return;
    }
    const nextMessageId = queuedMessages[0]?.id;
    if (nextMessageId && !isPending && autoDispatchedQueueIdRef.current !== nextMessageId) {
      autoDispatchedQueueIdRef.current = nextMessageId;
      dispatchQueuedMessage(nextMessageId);
    }
  }, [isAgentRunning, isPending, queuedMessages]);

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
    function handlePointerDown(event: MouseEvent): void {
      if (!pickerRef.current) {
        return;
      }
      if (!pickerRef.current.contains(event.target as Node)) {
        setShowPicker(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  useEffect(() => () => {
    if (focusComposerRequestRef.current !== null) {
      window.cancelAnimationFrame(focusComposerRequestRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    scrollAnchorsRef.current = readConversationScrollAnchors(scrollAnchorStorageKey);
  }, [scrollAnchorStorageKey]);

  const saveThreadScrollAnchor = useCallback(
    (threadId: string | null) => {
      if (!threadId || !scrollAnchorStorageKey) {
        return;
      }

      const viewport = threadViewportRef.current;
      if (!viewport) {
        return;
      }

      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const anchor = buildConversationScrollAnchor(viewport, distanceFromBottom < 64);
      scrollAnchorsRef.current = pruneConversationScrollAnchors({
        ...scrollAnchorsRef.current,
        [threadId]: anchor,
      });
      writeConversationScrollAnchors(scrollAnchorStorageKey, scrollAnchorsRef.current);
    },
    [scrollAnchorStorageKey],
  );

  useLayoutEffect(() => {
    return () => {
      saveThreadScrollAnchor(selectedItemId);
      threadViewportVisibleRef.current = false;
    };
  }, [hasCustomThreadContent, saveThreadScrollAnchor, selectedItemId]);

  useLayoutEffect(() => {
    const viewport = threadViewportRef.current;
    if (!viewport) {
      threadViewportVisibleRef.current = false;
      return;
    }

    const switchedConversation = previousSelectedIdRef.current !== selectedItemId;
    previousSelectedIdRef.current = selectedItemId;
    const threadBecameVisible = !threadViewportVisibleRef.current;
    threadViewportVisibleRef.current = true;
    const savedAnchor = selectedItemId ? scrollAnchorsRef.current[selectedItemId] : undefined;

    if ((switchedConversation || threadBecameVisible) && restoreConversationScrollAnchor(viewport, savedAnchor)) {
      shouldStickToBottomRef.current = savedAnchor?.stickToBottom ?? true;
      return;
    }
    if (
      switchedConversation ||
      (isPending && !pendingMessageScrollRef.current) ||
      shouldStickToBottomRef.current
    ) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [hasCustomThreadContent, isPending, messages, selectedItemId]);

  useLayoutEffect(() => {
    const target = pendingMessageScrollRef.current;
    const viewport = threadViewportRef.current;
    if (!target || !viewport) {
      return;
    }

    const serverMessageCopy = messages.find((message) => (
      !target.serverMessageIdsAtSubmission.includes(message.id) &&
      message.role === "human" &&
      message.content === target.content &&
      message.replyToMessageId === target.replyToMessageId
    ));
    const targetMessageIds = new Set([target.id, serverMessageCopy?.id]);
    const submittedMessage = Array.from(
      viewport.querySelectorAll<HTMLElement>("[data-conversation-message-id]"),
    ).find((element) => targetMessageIds.has(element.dataset.conversationMessageId));
    if (!submittedMessage) {
      return;
    }

    if (typeof submittedMessage.scrollIntoView === "function") {
      submittedMessage.scrollIntoView({ block: "center", inline: "nearest" });
      shouldStickToBottomRef.current = false;
    }
    if (!isPending) {
      pendingMessageScrollRef.current = null;
    }
  }, [isPending, messages, optimisticMessages, selectedItemId]);

  useEffect(() => {
    if (!isCompactLayout) {
      setMobilePane("list");
      return;
    }

    setMobilePane(selectedHeader ? "thread" : "list");
  }, [isCompactLayout, selectedItemId, Boolean(selectedHeader)]);

  useEffect(() => {
    if (!isCompactLayout || !supplementaryPanel || !onCloseSupplementaryPanel) {
      return;
    }

    const closeSupplementaryPanel = onCloseSupplementaryPanel;

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        closeSupplementaryPanel();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isCompactLayout, onCloseSupplementaryPanel, supplementaryPanel]);

  const activeMentionQuery = findDraftMentionQuery(draft, draftCaretIndex);
  const mentionSuggestions = useMemo(
    () =>
      activeMentionQuery
        ? mentionCandidates
            .filter((candidate) => {
              const query = activeMentionQuery.query.trim();
              if (!query) {
                return true;
              }
              return (
                candidate.label.toLocaleLowerCase("zh-CN").includes(query.toLocaleLowerCase("zh-CN")) ||
                candidate.subtitle.toLocaleLowerCase("zh-CN").includes(query.toLocaleLowerCase("zh-CN"))
              );
            })
            .sort((left, right) => {
              if (left.inChannel !== right.inChannel) {
                return left.inChannel ? -1 : 1;
              }
              return left.label.localeCompare(right.label, "zh-CN", { sensitivity: "base" });
            })
        : [],
    [activeMentionQuery, mentionCandidates],
  );
  const activeSlashQuery = findDraftSlashQuery(draft, draftCaretIndex);
  const slashSuggestions = useMemo(() => {
    if (!activeSlashQuery) {
      return [];
    }
    const query = activeSlashQuery.query.toLocaleLowerCase("zh-CN");
    return buildComposerSlashCommands(composerRuntime?.provider, tx).filter((command) =>
      !query ||
      command.command.slice(1).toLocaleLowerCase("zh-CN").includes(query) ||
      command.label.toLocaleLowerCase("zh-CN").includes(query)
    );
  }, [activeSlashQuery, composerRuntime?.provider, tx]);
  const effectiveExecutionPolicy = executionPolicyOverride === undefined
    ? composerRuntime?.executionPolicy
    : executionPolicyOverride ?? undefined;

  const handleSelectListItem = useCallback(
    (id: string) => {
      saveThreadScrollAnchor(selectedItemId);
      onSelectItem(id);
      if (isCompactLayout) {
        setMobilePane("thread");
      }
    },
    [isCompactLayout, onSelectItem, saveThreadScrollAnchor, selectedItemId],
  );

  function handleThreadScroll(): void {
    const viewport = threadViewportRef.current;
    if (!viewport) {
      return;
    }

    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom < 64;
    if (selectedItemId && scrollAnchorStorageKey) {
      scrollAnchorsRef.current = pruneConversationScrollAnchors({
        ...scrollAnchorsRef.current,
        [selectedItemId]: buildConversationScrollAnchor(viewport, shouldStickToBottomRef.current),
      });
    }
  }

  function handlePickedFiles(files: FileList | File[] | null): void {
    if (!files || files.length === 0) {
      return;
    }

    const next = Array.from(files).map((file) => ({
      id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
      file,
      label:
        typeof (file as File & { webkitRelativePath?: string }).webkitRelativePath === "string" &&
        (file as File & { webkitRelativePath?: string }).webkitRelativePath
          ? (file as File & { webkitRelativePath?: string }).webkitRelativePath!
          : file.name,
    }));

    setPendingFiles((current) => [...current, ...next]);
    setShowPicker(false);
  }

  function submitMessage(): void {
    if (!selectedHeader || (draft.trim().length === 0 && pendingFiles.length === 0 && selectedReferences.length === 0)) {
      return;
    }

    const submittedSlashCommand = resolveSubmittedSlashCommand(draft, composerRuntime?.provider, tx);
    if (submittedSlashCommand) {
      executeSlashCommand(submittedSlashCommand, { value: "", caretIndex: 0 });
      return;
    }

    const content = draft.trim().length > 0
      ? draft
      : tx("请查看我发送或引用的内容。", "Please review the content I sent or referenced.");
    const referenceAttachmentIds = selectedReferences
      .filter((reference) => reference.kind === "file")
      .map((reference) => reference.sourceId);
    const referenceSkillIds = selectedReferences
      .filter((reference) => reference.kind === "skill")
      .map((reference) => reference.sourceId);
    if (isAgentRunning && pendingFiles.length === 0) {
      setQueuedMessages((current) => [
        ...current,
        {
          id: `queued-message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          content,
          replyToMessageId: replyToMessage?.id,
          createdAt: new Date().toISOString(),
          referenceAttachmentIds,
          referenceSkillIds,
        },
      ]);
      setDraft("");
      setDraftCaretIndex(0);
      setSelectedReferences([]);
      setReplyToMessage(null);
      setMentionFeedback(null);
      setFeedback(null);
      return;
    }

    const submittedDraft = draft;
    const submittedFiles = pendingFiles;
    const submittedReplyToMessage = replyToMessage;
    const submittedReferences = selectedReferences;
    const optimisticMessageId = selectedItemId
      ? `optimistic-message-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      : null;
    if (optimisticMessageId && selectedItemId) {
      const optimisticMessage: OptimisticConversationMessage = {
        id: optimisticMessageId,
        conversationId: selectedItemId,
        serverMessageIdsAtSubmission: messages.map((message) => message.id),
        speaker: currentUserDisplayName?.trim() || tx("你", "You"),
        role: "human",
        content,
        timestamp: new Date().toISOString(),
        status: "completed",
        deliveryStatus: "sending",
        replyToMessageId: submittedReplyToMessage?.id,
      };
      pendingMessageScrollRef.current = optimisticMessage;
      setOptimisticMessages((current) => [
        ...current.filter((message) => !(
          message.conversationId === selectedItemId &&
          message.deliveryStatus === "failed" &&
          message.content === content
        )),
        optimisticMessage,
      ]);
      shouldStickToBottomRef.current = true;
    }
    setMentionFeedback(null);
    setFeedback(null);
    setDraft("");
    setDraftCaretIndex(0);
    setPendingFiles([]);
    setSelectedReferences([]);
    setShowPicker(false);
    setReplyToMessage(null);
    startTransition(async () => {
      try {
        await onSubmit({
          content,
          files: submittedFiles.map((item) => item.file),
          replyToMessageId: submittedReplyToMessage?.id,
          ...(referenceAttachmentIds.length > 0 ? { referenceAttachmentIds } : {}),
          ...(referenceSkillIds.length > 0 ? { referenceSkillIds } : {}),
        });
        if (optimisticMessageId) {
          setOptimisticMessages((current) => current.map((message) => (
            message.id === optimisticMessageId ? { ...message, deliveryStatus: "sent" } : message
          )));
        }
        shouldStickToBottomRef.current = true;
        if (onDataChanged) {
          onDataChanged();
        } else {
          router.refresh();
        }
      } catch (error) {
        if (optimisticMessageId) {
          setOptimisticMessages((current) => current.map((message) => (
            message.id === optimisticMessageId ? { ...message, deliveryStatus: "failed" } : message
          )));
        }
        setDraft((current) => current || submittedDraft);
        setDraftCaretIndex((current) => current || submittedDraft.length);
        setPendingFiles((current) => [
          ...submittedFiles.filter((submitted) => current.every((item) => item.id !== submitted.id)),
          ...current,
        ]);
        setReplyToMessage((current) => current ?? submittedReplyToMessage);
        setSelectedReferences((current) => current.length > 0 ? current : submittedReferences);
        setFeedback(error instanceof Error ? error.message : tx("发送失败，请稍后重试。", "Send failed. Please try again."));
      }
    });
  }

  function dispatchQueuedMessage(messageId: string): void {
    const queued = queuedMessages.find((message) => message.id === messageId);
    if (!queued || isPending) {
      return;
    }
    setFeedback(null);
    startTransition(async () => {
      try {
        await onSubmit({
          content: queued.content,
          files: [],
          replyToMessageId: queued.replyToMessageId,
          ...(queued.referenceAttachmentIds?.length ? { referenceAttachmentIds: queued.referenceAttachmentIds } : {}),
          ...(queued.referenceSkillIds?.length ? { referenceSkillIds: queued.referenceSkillIds } : {}),
        });
        setQueuedMessages((current) => current.filter((message) => message.id !== messageId));
        shouldStickToBottomRef.current = true;
        if (onDataChanged) {
          onDataChanged();
        } else {
          router.refresh();
        }
      } catch (error) {
        setFeedback(error instanceof Error ? error.message : tx("排队消息发送失败，请重试。", "Queued message failed to send. Please try again."));
      }
    });
  }

  function stopActiveTask(): void {
    if (!onStopActiveTask || isPending) {
      return;
    }
    setFeedback(null);
    startTransition(async () => {
      try {
        await onStopActiveTask();
        if (onDataChanged) {
          onDataChanged();
        } else {
          router.refresh();
        }
      } catch (error) {
        setFeedback(error instanceof Error ? error.message : tx("停止执行失败，请重试。", "Failed to stop execution. Please try again."));
      }
    });
  }

  function handleDraftChange(nextDraft: string, caretIndex: number): void {
    if (focusComposerRequestRef.current !== null) {
      window.cancelAnimationFrame(focusComposerRequestRef.current);
      focusComposerRequestRef.current = null;
    }
    const mentionQuery = findDraftMentionQuery(nextDraft, caretIndex);
    const mentionUnavailable = mentionCandidates.length === 0 && mentionQuery?.query === "";
    setMentionFeedback(
      mentionUnavailable
        ? tx("当前没有可 @ 的成员或 AI员工。", "There are no members or AI employees available to mention.")
        : null,
    );
    if (mentionUnavailable) {
      setFeedback(null);
    }
    setDraft(nextDraft);
    setDraftCaretIndex(caretIndex);
  }

  function scheduleComposerFocus(caretIndex: number): void {
    if (focusComposerRequestRef.current !== null) {
      window.cancelAnimationFrame(focusComposerRequestRef.current);
    }
    focusComposerRequestRef.current = window.requestAnimationFrame(() => {
      focusComposerRequestRef.current = null;
      const target = textareaRef.current;
      if (!target) {
        return;
      }
      target.focus();
      target.setSelectionRange(caretIndex, caretIndex);
    });
  }

  function handleInsertMentionTrigger(): void {
    if (!selectedHeader) {
      return;
    }

    const target = textareaRef.current;
    const currentCaretIndex = target?.selectionStart ?? draftCaretIndex;
    const nextDraft = `${draft.slice(0, currentCaretIndex)}@${draft.slice(currentCaretIndex)}`;
    const nextCaretIndex = currentCaretIndex + 1;
    setDraft(nextDraft);
    setDraftCaretIndex(nextCaretIndex);
    setShowPicker(false);
    setMentionFeedback(
      mentionCandidates.length === 0
        ? tx("当前没有可 @ 的成员或 AI员工。", "There are no members or AI employees available to mention.")
        : null,
    );
    setFeedback(null);

    scheduleComposerFocus(nextCaretIndex);
  }

  function handleSelectMention(candidate: ConversationMentionCandidate): void {
    const isReference = candidate.kind === "file" || candidate.kind === "skill";
    const next = isReference && activeMentionQuery
      ? replaceDraftRange(draft, activeMentionQuery.start, draftCaretIndex, "")
      : applyMentionSelection(draft, draftCaretIndex, candidate.label);
    setDraft(next.value);
    setDraftCaretIndex(next.caretIndex);
    setMentionFeedback(null);
    const referenceKind = candidate.kind === "file" || candidate.kind === "skill" ? candidate.kind : undefined;
    const referenceSourceId = candidate.sourceId;
    if (referenceKind && referenceSourceId) {
      setSelectedReferences((current) => current.some((reference) =>
        reference.kind === referenceKind && reference.sourceId === referenceSourceId
      )
        ? current
        : [...current, {
            id: `${referenceKind}:${referenceSourceId}`,
            label: candidate.label,
            kind: referenceKind,
            sourceId: referenceSourceId,
          }]);
    }
    setFeedback(null);

    scheduleComposerFocus(next.caretIndex);
  }

  function handleSelectSlashCommand(command: ConversationSlashCommand): void {
    if (!activeSlashQuery) {
      return;
    }
    const next = replaceDraftRange(draft, activeSlashQuery.start, draftCaretIndex, "");
    executeSlashCommand(command, next);
  }

  function executeSlashCommand(
    command: ConversationSlashCommand,
    next: { value: string; caretIndex: number },
  ): void {
    setMentionFeedback(null);
    if (command.action === "clear") {
      setDraft("");
      setDraftCaretIndex(0);
      setSelectedReferences([]);
      setFeedback(null);
      return;
    }
    if (command.action === "model") {
      setDraft(next.value);
      setDraftCaretIndex(next.caretIndex);
      setFeedback(null);
      if (onOpenModelSelector) {
        onOpenModelSelector();
      } else {
        setFeedback(tx("当前会话暂时无法切换模型。", "Model switching is not available for this conversation."));
      }
      return;
    }
    if (command.action === "resume") {
      setDraft(next.value);
      setDraftCaretIndex(next.caretIndex);
      setFeedback(tx("当前运行时会话会在下一条消息中自动续接。", "The current runtime session will resume automatically with your next message."));
      scheduleComposerFocus(next.caretIndex);
      return;
    }
    if (command.action === "permissions") {
      setDraft(next.value);
      setDraftCaretIndex(next.caretIndex);
      setShowExecutionPolicyMenu(true);
      return;
    }
    setDraft(next.value);
    setDraftCaretIndex(next.caretIndex);
    const policy = policyForSlashCommand(command.action);
    if (policy) {
      void updateExecutionPolicy(policy);
    }
  }

  async function updateExecutionPolicy(policy?: EmployeeExecutionPolicy): Promise<void> {
    if (!composerRuntime || !onUpdateExecutionPolicy || isExecutionPolicyPending) {
      return;
    }
    const previousPolicy = effectiveExecutionPolicy;
    setExecutionPolicyOverride(policy ?? null);
    setShowExecutionPolicyMenu(false);
    setIsExecutionPolicyPending(true);
    setFeedback(null);
    try {
      await onUpdateExecutionPolicy(composerRuntime.employeeId, policy);
      onDataChanged?.();
    } catch (error) {
      setExecutionPolicyOverride(previousPolicy ?? null);
      setFeedback(error instanceof Error ? error.message : tx("执行权限保存失败，请重试。", "Failed to save execution permissions. Please try again."));
    } finally {
      setIsExecutionPolicyPending(false);
    }
  }

  function handleReplyToMessage(message: ConversationThreadMessage): void {
    setReplyToMessage(message);

    const replyMention = buildReplyMentionPrefix(message);
    if (!replyMention) {
      textareaRef.current?.focus();
      return;
    }

    const nextDraft = draft.startsWith(replyMention)
      ? draft
      : draft.trim().length > 0
        ? `${replyMention}${draft}`
        : replyMention;
    setDraft(nextDraft);
    setDraftCaretIndex(nextDraft.length);

    scheduleComposerFocus(nextDraft.length);
  }

  const displayedMessages = useMemo(
    () => orderConversationMessages([
      ...messages,
      ...optimisticMessages.filter((message) => message.conversationId === selectedItemId),
    ]),
    [messages, optimisticMessages, selectedItemId],
  );
  const pinnedMessages = useMemo(() => messages.filter((m) => m.pinned), [messages]);
  const messageById = useMemo(() => new Map(displayedMessages.map((m) => [m.id, m])), [displayedMessages]);
  const showListPane = !isCompactLayout || !selectedHeader || mobilePane === "list";
  const showThreadPane = !isCompactLayout || (Boolean(selectedHeader) && mobilePane === "thread");
  const showSupplementarySheet = Boolean(supplementaryPanel) && isCompactLayout;
  const showDesktopSupplementaryPane = Boolean(supplementaryPanel) && !isCompactLayout;
  const supplementaryTitle = supplementaryPanelTitle ?? tx("附加面板", "Supplementary panel");
  const {
    surfaceRef: supplementarySheetRef,
    handleBackdropMouseDown: handleSupplementarySheetBackdropMouseDown,
    labelId: supplementarySheetLabelId,
  } = useDialogSurface<HTMLDivElement>(onCloseSupplementaryPanel ?? (() => {}));

  return (
    <section
      className={`contacts-shell${shellClassName ? ` ${shellClassName}` : ""}${isCompactLayout ? " contacts-shell--compact" : ""}${showDesktopSupplementaryPane ? " contacts-shell--with-panel" : ""}`}
      style={listPaneResize.paneStyle}
    >
      {showListPane ? (
        <aside className="contacts-list-pane">
          <div className="contacts-list-pane__header">
            <div className="contacts-list-pane__header-copy">
              {listKicker && listKicker !== listTitle ? (
                <p className="page-eyebrow">{listKicker}</p>
              ) : null}
              <div className="contacts-list-pane__title-row">
                <h2>{listTitle}</h2>
                <span className="contacts-list-pane__count">{listCount}</span>
              </div>
            </div>
            {listActions ? <div className="contacts-list-pane__header-actions">{listActions}</div> : null}
          </div>

          <div className="contacts-list">
            {items.length > 0 ? (
              items.map((item) => (
                <ConversationListRow
                  item={item}
                  key={item.id}
                  onSelect={handleSelectListItem}
                  selected={selectedItemId === item.id}
                />
              ))
            ) : (
              <ChatEmptyState body={emptyListBody} title={emptyListTitle} />
            )}
          </div>
        </aside>
      ) : null}

      {!isCompactLayout && showListPane && showThreadPane ? (
        <PaneResizeHandle
          label={tx("调整会话列表宽度", "Resize conversation list")}
          maxValue={listPaneResize.maxWidth}
          minValue={listPaneResize.minWidth}
          onKeyDown={listPaneResize.onHandleKeyDown}
          onPointerDown={listPaneResize.onHandlePointerDown}
          value={listPaneResize.width}
        />
      ) : null}

      {showThreadPane ? (
        <section className="contacts-chat-pane">
          {selectedHeader ? (
            <>
              {customThreadHeader?.({
                backButton: isCompactLayout ? (
                  <button
                    aria-label={tx("返回列表", "Back to list")}
                    className="contacts-chat-header__back"
                    onClick={() => setMobilePane("list")}
                    type="button"
                  >
                    <AppIcon name="arrowLeft" />
                  </button>
                ) : null,
              }) ?? (
                <ChatHeader
                  actions={headerActions}
                  avatar={selectedHeader.avatar}
                  avatarId={selectedHeader.avatarId}
                  avatarName={selectedHeader.avatarName}
                  avatarVariant={selectedHeader.avatarVariant}
                  leadingAction={
                    isCompactLayout ? (
                      <button
                        aria-label={tx("返回列表", "Back to list")}
                        className="contacts-chat-header__back"
                        onClick={() => setMobilePane("list")}
                        type="button"
                      >
                        <AppIcon name="arrowLeft" />
                      </button>
                    ) : undefined
                  }
                  subtitle={selectedHeader.subtitle}
                  title={selectedHeader.title}
                />
              )}

              {customThreadContent ?? (
                <>
                  {pinnedMessages.length > 0 ? (
                    <div className="pinned-messages-bar">
                      <strong>{tx("置顶消息", "Pinned")}</strong>
                      <div className="pinned-messages-bar__list">
                        {pinnedMessages.slice(0, 3).map((m) => (
                          <div className="pinned-messages-bar__item" key={m.id}>
                            <span className="pinned-messages-bar__speaker">{translateSystemSpeaker(m.speaker, tx)}:</span>
                            <span className="pinned-messages-bar__text">
                              {m.content.slice(0, 60)}
                              {m.content.length > 60 ? "..." : ""}
                            </span>
                            {onUnpinMessage ? (
                              <button
                                className="pinned-messages-bar__unpin"
                                onClick={() => onUnpinMessage(m.id)}
                                title={tx("取消置顶", "Unpin")}
                                type="button"
                              >
                                <AppIcon name="close" />
                              </button>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  <div className="contacts-chat-thread" onScroll={handleThreadScroll} ref={threadViewportRef}>
                    {displayedMessages.length > 0 ? (
                      displayedMessages.map((message) => (
                        <ConversationMessageBubble
                          isOwn={isOwnHumanMessage(message, currentUserDisplayName)}
                          key={message.id}
                          message={message}
                          acknowledgementActorLabel={currentUserDisplayName}
                          replyToMessage={message.replyToMessageId ? messageById.get(message.replyToMessageId) : undefined}
                          onReply={() => handleReplyToMessage(message)}
                          onPin={onPinMessage && !message.pinned ? () => onPinMessage(message.id) : undefined}
                          onUnpin={onUnpinMessage && message.pinned ? () => onUnpinMessage(message.id) : undefined}
                          onAcknowledge={onAcknowledgeMessage ? () => onAcknowledgeMessage(message.id) : undefined}
                          onReviewApproval={onReviewApproval}
                        />
                      ))
                    ) : !threadHasSupplementaryContent ? (
                      <ChatEmptyState body={emptyThreadBody} title={emptyThreadTitle} />
                    ) : null}
                    {threadAfterMessages}
                  </div>

                  <ChatComposer
                    caretIndex={draftCaretIndex}
                    draft={draft}
                    executionPolicy={effectiveExecutionPolicy}
                    executionPolicyPending={isExecutionPolicyPending}
                    feedback={feedback ?? mentionFeedback}
                    fileInputRef={fileInputRef}
                    files={pendingFiles}
                    folderInputRef={folderInputRef}
                    isPending={isPending}
                    isAgentRunning={isAgentRunning}
                    mediaInputRef={mediaInputRef}
                    mentionSuggestions={mentionSuggestions}
                    references={selectedReferences}
                    runtime={composerRuntime}
                    slashSuggestions={slashSuggestions}
                    onDraftChange={handleDraftChange}
                    onInsertMentionTrigger={handleInsertMentionTrigger}
                    onPickedFiles={handlePickedFiles}
                    onRemoveFile={(id) => setPendingFiles((current) => current.filter((entry) => entry.id !== id))}
                    onRemoveReference={(id) => setSelectedReferences((current) => current.filter((reference) => reference.id !== id))}
                    onSelectMention={handleSelectMention}
                    onSelectSlashCommand={handleSelectSlashCommand}
                    onSelectExecutionPolicy={(policy) => void updateExecutionPolicy(policy)}
                    onSubmit={submitMessage}
                    onStop={onStopActiveTask ? stopActiveTask : undefined}
                    queuedMessages={queuedMessages}
                    onClearQueue={() => setQueuedMessages([])}
                    onDeleteQueuedMessage={(id) => setQueuedMessages((current) => current.filter((message) => message.id !== id))}
                    onEditQueuedMessage={(id, content) => setQueuedMessages((current) => current.map((message) => (
                      message.id === id ? { ...message, content } : message
                    )))}
                    onGuideQueuedMessage={dispatchQueuedMessage}
                    onTogglePicker={() => {
                      setShowExecutionPolicyMenu(false);
                      setShowPicker((value) => !value);
                    }}
                    pickerRef={pickerRef}
                    placeholder={placeholder}
                    replyToMessage={replyToMessage}
                    onCancelReply={() => setReplyToMessage(null)}
                    showPicker={showPicker}
                    showExecutionPolicyMenu={showExecutionPolicyMenu}
                    onToggleExecutionPolicyMenu={() => {
                      setShowPicker(false);
                      setShowExecutionPolicyMenu((value) => !value);
                    }}
                    textareaRef={textareaRef}
                  />
                </>
              )}
            </>
          ) : (
            <ChatEmptyState body={emptyThreadBody} title={emptyThreadTitle} />
          )}
        </section>
      ) : null}

      {showDesktopSupplementaryPane ? (
        <aside className="contacts-supplementary-pane">
          <div className="contacts-supplementary-pane__header">
            <div>
              <h3>{supplementaryTitle}</h3>
            </div>
            {onCloseSupplementaryPanel ? (
              <button
                aria-label={tx("关闭面板", "Close panel")}
                className="contacts-supplementary-pane__close"
                onClick={onCloseSupplementaryPanel}
                type="button"
              >
                <AppIcon name="close" />
              </button>
            ) : null}
          </div>
          <div className="contacts-supplementary-pane__content">{supplementaryPanel}</div>
        </aside>
      ) : null}

      {showSupplementarySheet ? (
        <div
          aria-labelledby={supplementarySheetLabelId}
          aria-modal="true"
          className="contacts-supplementary-sheet"
          onMouseDown={handleSupplementarySheetBackdropMouseDown}
          role="dialog"
        >
          {onCloseSupplementaryPanel ? (
            <button
              aria-label={tx("关闭面板", "Close panel")}
              className="contacts-supplementary-sheet__backdrop"
              onClick={onCloseSupplementaryPanel}
              type="button"
            />
          ) : (
            <div aria-hidden="true" className="contacts-supplementary-sheet__backdrop" />
          )}
          <div className="contacts-supplementary-sheet__panel" ref={supplementarySheetRef} tabIndex={-1}>
            <div className="contacts-supplementary-sheet__handle" />
            <div className="contacts-supplementary-sheet__header">
              <div>
                <h3 id={supplementarySheetLabelId}>{supplementaryTitle}</h3>
              </div>
              {onCloseSupplementaryPanel ? (
                <button
                  aria-label={tx("关闭面板", "Close panel")}
                  className="contacts-supplementary-sheet__close"
                  onClick={onCloseSupplementaryPanel}
                  type="button"
                >
                  <AppIcon name="close" />
                </button>
              ) : null}
            </div>
            <div className="contacts-supplementary-sheet__content">{supplementaryPanel}</div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
