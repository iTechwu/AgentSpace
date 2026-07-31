"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChatComposer, ChatEmptyState, ChatHeader, ConversationListRow, ConversationMessageBubble } from "@/features/chat/chat-primitives";
import type { MessageAcknowledgement, MessageAttachment, MessageMention } from "@/shared/types/workspace";
import { applyMentionSelection, findDraftMentionQuery } from "@dofe-agent/domain";
import { useLanguage } from "@/features/i18n/language-provider";
import { translateSystemSpeaker } from "@/features/i18n/presentation";
import { AppIcon } from "@/shared/ui/app-icon";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";
import { useResizablePane } from "@/shared/lib/use-resizable-pane";
import { PaneResizeHandle } from "@/shared/ui/pane-resize-handle";
import type { GeneratedAvatarVariant } from "@/shared/ui/generated-avatar";
import type { EmployeeExecutionPolicy } from "@dofe-agent/domain/workspace";

export interface ConversationListItem {
  id: string;
  title: string;
  subtitle: string;
  meta: string;
  avatar: string;
  avatarId?: string;
  avatarName?: string;
  avatarVariant?: GeneratedAvatarVariant;
  dateLabel?: string;
  unread?: boolean;
}

export interface ConversationThreadMessage {
  id: string;
  speaker: string;
  role: "human" | "agent";
  content: string;
  code?: string;
  data?: Record<string, string>;
  timestamp: string;
  status: "pending" | "completed" | "error";
  attachments?: MessageAttachment[];
  mentions?: MessageMention[];
  acknowledgements?: MessageAcknowledgement[];
  kind?: "message" | "process";
  processType?: string;
  tool?: string;
  pinned?: boolean;
  pinnedAt?: string;
  replyToMessageId?: string;
}

export interface ConversationMentionCandidate {
  id: string;
  label: string;
  subtitle: string;
  inChannel: boolean;
  kind?: "agent" | "human" | "file" | "skill";
  sourceId?: string;
}

export interface ConversationComposerRuntime {
  employeeId: string;
  employeeLabel: string;
  provider: "claude" | "codex";
  executionPolicy?: EmployeeExecutionPolicy;
  requiresMentionForCommands?: boolean;
}

export interface ConversationSlashCommand {
  id: string;
  command: string;
  label: string;
  description: string;
  action: "insert" | "clear" | "permissions" | "claude-plan" | "claude-auto" | "codex-review";
}

interface SelectedComposerReference {
  id: string;
  label: string;
  kind: "file" | "skill";
  sourceId: string;
}

type PendingFile = {
  id: string;
  file: File;
  label: string;
};

interface QueuedConversationMessage {
  id: string;
  content: string;
  replyToMessageId?: string;
  createdAt: string;
  referenceAttachmentIds?: string[];
  referenceSkillIds?: string[];
}

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
}) {
  const { tx } = useLanguage();
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [draftCaretIndex, setDraftCaretIndex] = useState(0);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [showExecutionPolicyMenu, setShowExecutionPolicyMenu] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [replyToMessage, setReplyToMessage] = useState<ConversationThreadMessage | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<QueuedConversationMessage[]>([]);
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
    if (switchedConversation || isPending || shouldStickToBottomRef.current) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [hasCustomThreadContent, isPending, messages, selectedItemId]);

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

  function handlePickedFiles(files: FileList | null): void {
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
      setFeedback(null);
      return;
    }

    const submittedDraft = draft;
    const submittedFiles = pendingFiles;
    const submittedReplyToMessage = replyToMessage;
    const submittedReferences = selectedReferences;
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
        shouldStickToBottomRef.current = true;
        if (onDataChanged) {
          onDataChanged();
        } else {
          router.refresh();
        }
      } catch (error) {
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
    if (mentionCandidates.length === 0) {
      setFeedback(tx("当前没有可 @ 的成员或 AI员工。", "There are no members or AI employees available to mention."));
      return;
    }

    const target = textareaRef.current;
    const currentCaretIndex = target?.selectionStart ?? draftCaretIndex;
    const nextDraft = `${draft.slice(0, currentCaretIndex)}@${draft.slice(currentCaretIndex)}`;
    const nextCaretIndex = currentCaretIndex + 1;
    setDraft(nextDraft);
    setDraftCaretIndex(nextCaretIndex);
    setShowPicker(false);
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
    if (command.action === "clear") {
      setDraft("");
      setDraftCaretIndex(0);
      setSelectedReferences([]);
      return;
    }

    const next = replaceDraftRange(draft, activeSlashQuery.start, draftCaretIndex, "");
    if (command.action === "permissions") {
      setDraft(next.value);
      setDraftCaretIndex(next.caretIndex);
      setShowExecutionPolicyMenu(true);
      return;
    }
    if (command.action !== "insert") {
      setDraft(next.value);
      setDraftCaretIndex(next.caretIndex);
      const policy = policyForSlashCommand(command.action);
      if (policy) {
        void updateExecutionPolicy(policy);
      }
      return;
    }

    const commandText = command.id === "resume" && composerRuntime?.requiresMentionForCommands
      ? `${command.command} @${composerRuntime.employeeLabel} `
      : `${command.command} `;
    const inserted = replaceDraftRange(draft, activeSlashQuery.start, draftCaretIndex, commandText);
    setDraft(inserted.value);
    setDraftCaretIndex(inserted.caretIndex);
    scheduleComposerFocus(inserted.caretIndex);
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

  const pinnedMessages = useMemo(() => messages.filter((m) => m.pinned), [messages]);
  const messageById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
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
                    {messages.length > 0 ? (
                      messages.map((message) => (
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
                    ) : (
                      <ChatEmptyState body={emptyThreadBody} title={emptyThreadTitle} />
                    )}
                  </div>

                  <ChatComposer
                    caretIndex={draftCaretIndex}
                    draft={draft}
                    executionPolicy={effectiveExecutionPolicy}
                    executionPolicyPending={isExecutionPolicyPending}
                    feedback={feedback}
                    fileInputRef={fileInputRef}
                    files={pendingFiles.map((item) => ({ id: item.id, label: item.label }))}
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

interface ConversationScrollAnchor {
  messageId?: string;
  messageOffsetTop?: number;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
  stickToBottom: boolean;
  updatedAt: number;
}

const CONVERSATION_SCROLL_ANCHOR_LIMIT = 40;

function buildConversationScrollAnchor(
  viewport: HTMLDivElement,
  stickToBottom: boolean,
): ConversationScrollAnchor {
  const firstVisibleMessage = findFirstVisibleConversationMessage(viewport);
  return {
    messageId: firstVisibleMessage?.messageId,
    messageOffsetTop: firstVisibleMessage?.offsetTop,
    scrollTop: viewport.scrollTop,
    scrollHeight: viewport.scrollHeight,
    clientHeight: viewport.clientHeight,
    distanceFromBottom: Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight),
    stickToBottom,
    updatedAt: Date.now(),
  };
}

function restoreConversationScrollAnchor(
  viewport: HTMLDivElement,
  anchor: ConversationScrollAnchor | undefined,
): boolean {
  if (!anchor) {
    return false;
  }

  if (anchor.stickToBottom) {
    viewport.scrollTop = viewport.scrollHeight;
    return true;
  }

  if (anchor.messageId && typeof anchor.messageOffsetTop === "number") {
    const anchoredMessage = Array.from(
      viewport.querySelectorAll<HTMLElement>("[data-conversation-message-id]"),
    ).find((element) => element.dataset.conversationMessageId === anchor.messageId);
    if (
      anchoredMessage &&
      (anchoredMessage.offsetTop > 0 || anchoredMessage.offsetHeight > 0)
    ) {
      viewport.scrollTop = Math.max(0, anchoredMessage.offsetTop - anchor.messageOffsetTop);
      return true;
    }
  }

  if (viewport.scrollHeight > viewport.clientHeight) {
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight - anchor.distanceFromBottom);
    return true;
  }

  viewport.scrollTop = anchor.scrollTop;
  return true;
}

function findFirstVisibleConversationMessage(
  viewport: HTMLDivElement,
): { messageId: string; offsetTop: number } | null {
  for (const element of viewport.querySelectorAll<HTMLElement>("[data-conversation-message-id]")) {
    if (element.offsetTop === 0 && element.offsetHeight === 0) {
      continue;
    }
    if (element.offsetTop + element.offsetHeight >= viewport.scrollTop) {
      return {
        messageId: element.dataset.conversationMessageId ?? "",
        offsetTop: element.offsetTop - viewport.scrollTop,
      };
    }
  }
  return null;
}

function readConversationScrollAnchors(storageKey?: string): Record<string, ConversationScrollAnchor> {
  if (!storageKey || typeof window === "undefined") {
    return {};
  }
  const raw = window.sessionStorage.getItem(storageKey);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const anchors: Record<string, ConversationScrollAnchor> = {};
    for (const [threadId, value] of Object.entries(parsed)) {
      if (isConversationScrollAnchor(value)) {
        anchors[threadId] = value;
      }
    }
    return pruneConversationScrollAnchors(anchors);
  } catch {
    window.sessionStorage.removeItem(storageKey);
    return {};
  }
}

function writeConversationScrollAnchors(
  storageKey: string,
  anchors: Record<string, ConversationScrollAnchor>,
): void {
  if (typeof window === "undefined") {
    return;
  }
  if (Object.keys(anchors).length === 0) {
    window.sessionStorage.removeItem(storageKey);
    return;
  }
  window.sessionStorage.setItem(storageKey, JSON.stringify(anchors));
}

function pruneConversationScrollAnchors(
  anchors: Record<string, ConversationScrollAnchor>,
): Record<string, ConversationScrollAnchor> {
  const entries = Object.entries(anchors)
    .filter(([, anchor]) => isConversationScrollAnchor(anchor))
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, CONVERSATION_SCROLL_ANCHOR_LIMIT);
  return Object.fromEntries(entries);
}

function isConversationScrollAnchor(value: unknown): value is ConversationScrollAnchor {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ConversationScrollAnchor>;
  return (
    typeof candidate.scrollTop === "number" &&
    typeof candidate.scrollHeight === "number" &&
    typeof candidate.clientHeight === "number" &&
    typeof candidate.distanceFromBottom === "number" &&
    typeof candidate.stickToBottom === "boolean" &&
    typeof candidate.updatedAt === "number"
  );
}

function isOwnHumanMessage(
  message: ConversationThreadMessage,
  currentUserDisplayName?: string,
): boolean {
  if (message.role !== "human") {
    return false;
  }
  const normalizedCurrentUser = currentUserDisplayName?.trim();
  if (!normalizedCurrentUser) {
    return true;
  }
  const speaker = message.speaker.trim();
  return (
    speaker.localeCompare(normalizedCurrentUser, "zh-CN", { sensitivity: "base" }) === 0 ||
    speaker === "你" ||
    speaker.localeCompare("You", "en-US", { sensitivity: "base" }) === 0
  );
}

function buildReplyMentionPrefix(
  message: ConversationThreadMessage,
): string | null {
  if (message.role !== "agent") {
    return null;
  }

  const trimmed = message.speaker.trim();
  if (!trimmed) {
    return null;
  }
  return `@${trimmed} `;
}

function findDraftSlashQuery(draft: string, caretIndex: number): { start: number; query: string } | null {
  const prefix = draft.slice(0, Math.max(0, Math.min(caretIndex, draft.length)));
  const match = /(^|\s)\/([^\s/]*)$/.exec(prefix);
  if (!match) {
    return null;
  }
  const slashOffset = match[1]?.length ?? 0;
  return {
    start: match.index + slashOffset,
    query: match[2] ?? "",
  };
}

function replaceDraftRange(
  draft: string,
  start: number,
  end: number,
  replacement: string,
): { value: string; caretIndex: number } {
  const value = `${draft.slice(0, start)}${replacement}${draft.slice(end)}`;
  return { value, caretIndex: start + replacement.length };
}

function buildComposerSlashCommands(
  provider: ConversationComposerRuntime["provider"] | undefined,
  tx: (zh: string, en: string) => string,
): ConversationSlashCommand[] {
  const commands: ConversationSlashCommand[] = [
    {
      id: "model",
      command: "/model",
      label: tx("切换模型", "Switch model"),
      description: tx("为当前会话选择模型", "Choose a model for this conversation"),
      action: "insert",
    },
  ];
  if (provider) {
    commands.push({
      id: "resume",
      command: "/resume",
      label: tx("继续会话", "Resume session"),
      description: tx("沿用当前运行时会话继续处理", "Continue with the current runtime session"),
      action: "insert",
    });
    commands.push({
      id: "permissions",
      command: "/permissions",
      label: tx("执行权限", "Execution permissions"),
      description: tx("调整后续任务的工具与文件访问级别", "Adjust tool and file access for future tasks"),
      action: "permissions",
    });
  }
  if (provider === "claude") {
    commands.push(
      {
        id: "plan",
        command: "/plan",
        label: tx("Plan 模式", "Plan mode"),
        description: tx("仅规划，不直接修改文件", "Plan without directly editing files"),
        action: "claude-plan",
      },
      {
        id: "auto",
        command: "/auto",
        label: tx("Auto 模式", "Auto mode"),
        description: tx("由 Claude Code 自动处理权限", "Let Claude Code handle permissions automatically"),
        action: "claude-auto",
      },
    );
  }
  if (provider === "codex") {
    commands.push({
      id: "review",
      command: "/review",
      label: tx("需要时审批", "Ask when needed"),
      description: tx("切换为 Codex 帮我审批模式", "Switch Codex to ask-me-when-needed mode"),
      action: "codex-review",
    });
  }
  commands.push({
    id: "clear",
    command: "/clear",
    label: tx("清空输入", "Clear composer"),
    description: tx("移除当前草稿与引用", "Remove the current draft and references"),
    action: "clear",
  });
  return commands;
}

function policyForSlashCommand(action: ConversationSlashCommand["action"]): EmployeeExecutionPolicy | undefined {
  if (action === "claude-plan") {
    return { claudePermissionMode: "plan" };
  }
  if (action === "claude-auto") {
    return { claudePermissionMode: "auto" };
  }
  if (action === "codex-review") {
    return { codexApprovalPolicy: "on-request", codexSandboxMode: "workspace-write" };
  }
  return undefined;
}
