// 频道文档变更集/冲突域：变更集视图记录、后台同步事件、冲突合并预览与
// 操作 JSON 的解析/建议草稿/摘要/可重试判定。
import type {
  listQueuedTasksSync,
} from "@dofe-agent/db";
import type {
  WorkspaceMessage,
} from "@dofe-agent/domain/workspace";
import type {
  ChannelDocument,
  ChannelDocumentBlock,
  ChannelDocumentChangeSet,
  ChannelDocumentConflict,
  ChannelDocumentRunStep,
  ChannelDocumentVersion,
} from "@dofe-agent/domain";
import type {
  ChannelDocumentChangeSetRecord,
  ChannelDocumentConflictRecord,
  ChannelDocumentSyncEventRecord,
} from "../data-types";
import { safeReadTaskTitle } from "./task-queue";

export const CHANNEL_DOCUMENT_SYNC_EVENT_TTL_MS = 10 * 60_000;

export function buildChannelDocumentChangeSetRecord(
  changeSet: ChannelDocumentChangeSet,
  context: {
    messageIndex: Map<string, WorkspaceMessage>;
    queuedTaskIndex: Map<string, ReturnType<typeof listQueuedTasksSync>[number]>;
    runStepByQueuedTaskId: Map<string, ChannelDocumentRunStep>;
    runStepByDocumentVersionId: Map<string, ChannelDocumentRunStep>;
  },
): ChannelDocumentChangeSetRecord {
  const sourceMessage = changeSet.sourceMessageId ? context.messageIndex.get(changeSet.sourceMessageId) : undefined;
  const sourceTask = changeSet.sourceTaskQueueId ? context.queuedTaskIndex.get(changeSet.sourceTaskQueueId) : undefined;
  const sourceStep =
    (changeSet.sourceTaskQueueId ? context.runStepByQueuedTaskId.get(changeSet.sourceTaskQueueId) : undefined) ??
    (changeSet.documentVersionId ? context.runStepByDocumentVersionId.get(changeSet.documentVersionId) : undefined);

  return {
    id: changeSet.id,
    documentId: changeSet.documentId,
    actorId: changeSet.actorId,
    actorType: changeSet.actorType,
    baseVersionId: changeSet.baseVersionId,
    documentVersionId: changeSet.documentVersionId,
    status: changeSet.status,
    sourceMessageId: changeSet.sourceMessageId,
    sourceTaskQueueId: changeSet.sourceTaskQueueId,
    createdAt: changeSet.createdAt,
    operationSummary: summarizeChangeSetOperations(changeSet.operationsJson),
    sourceMessage: sourceMessage
      ? {
          id: sourceMessage.id,
          speaker: sourceMessage.speaker,
          summary: sourceMessage.summary,
          time: sourceMessage.time,
        }
      : undefined,
    sourceTask: sourceTask
      ? {
          id: sourceTask.id,
          title: safeReadTaskTitle(sourceTask.inputJson) ?? sourceTask.id,
          status: sourceTask.status,
        }
      : undefined,
    sourceStep: sourceStep
      ? {
          id: sourceStep.id,
          runId: sourceStep.runId,
          agentLabel: sourceStep.agentLabel,
          instruction: sourceStep.instruction,
          status: sourceStep.status,
        }
      : undefined,
    retryable: isRetryableChangeSetOperations(changeSet.operationsJson),
  };
}

export function buildChannelDocumentSyncEventRecord(
  version: ChannelDocumentVersion,
  context: {
    messageIndex: Map<string, WorkspaceMessage>;
    queuedTaskIndex: Map<string, ReturnType<typeof listQueuedTasksSync>[number]>;
    runStepByDocumentVersionId: Map<string, ChannelDocumentRunStep>;
  },
): ChannelDocumentSyncEventRecord | undefined {
  if (version.triggerType === "manual" && version.createdByType === "human") {
    return undefined;
  }

  const sourceMessage = version.sourceMessageId ? context.messageIndex.get(version.sourceMessageId) : undefined;
  const sourceTask = version.sourceTaskQueueId ? context.queuedTaskIndex.get(version.sourceTaskQueueId) : undefined;
  const sourceStep = context.runStepByDocumentVersionId.get(version.id);
  const createdAt = new Date(version.createdAt).getTime();

  return {
    actorId: version.createdBy,
    actorType: version.createdByType,
    triggerType: version.triggerType,
    versionId: version.id,
    createdAt: version.createdAt,
    isRecent: Number.isFinite(createdAt) ? Date.now() - createdAt <= CHANNEL_DOCUMENT_SYNC_EVENT_TTL_MS : false,
    sourceMessage: sourceMessage
      ? {
          id: sourceMessage.id,
          speaker: sourceMessage.speaker,
          summary: sourceMessage.summary,
          time: sourceMessage.time,
        }
      : undefined,
    sourceTask: sourceTask
      ? {
          id: sourceTask.id,
          title: safeReadTaskTitle(sourceTask.inputJson) ?? sourceTask.id,
          status: sourceTask.status,
        }
      : undefined,
    sourceStep: sourceStep
      ? {
          id: sourceStep.id,
          runId: sourceStep.runId,
          agentLabel: sourceStep.agentLabel,
          instruction: sourceStep.instruction,
          status: sourceStep.status,
        }
      : undefined,
  };
}

export function buildChannelDocumentConflictMergePreview(input: {
  conflict: ChannelDocumentConflict;
  document?: ChannelDocument;
  currentVersion?: ChannelDocumentVersion;
  currentBlocks: ChannelDocumentBlock[];
  rightChangeSet?: ChannelDocumentChangeSet;
}): ChannelDocumentConflictRecord["mergePreview"] {
  const parsedOperations = parseChannelDocumentChangeSetOperations(input.rightChangeSet?.operationsJson);
  if (parsedOperations.length === 0) {
    return undefined;
  }

  const replaceDocumentOperation = parsedOperations.find((operation) => operation.op === "replace_document");
  if (replaceDocumentOperation && typeof replaceDocumentOperation.contentMarkdown === "string") {
    return {
      mode: "document",
      currentLabel: "当前版本",
      currentContentMarkdown: input.currentVersion?.contentMarkdown ?? "",
      incomingLabel: "冲突改动",
      incomingContentMarkdown: replaceDocumentOperation.contentMarkdown,
      suggestedDraftContentMarkdown: replaceDocumentOperation.contentMarkdown,
      suggestedDraftTitle:
        typeof replaceDocumentOperation.title === "string" && replaceDocumentOperation.title.trim().length > 0
          ? replaceDocumentOperation.title
          : input.document?.title,
      suggestedDraftSummary:
        typeof replaceDocumentOperation.summary === "string" && replaceDocumentOperation.summary.trim().length > 0
          ? replaceDocumentOperation.summary
          : input.document?.summary,
    };
  }

  const focusedOperation =
    parsedOperations.find(
      (operation) =>
        "blockId" in operation &&
        typeof operation.blockId === "string" &&
        operation.blockId === input.conflict.blockId,
    ) ?? parsedOperations[0];
  if (!focusedOperation) {
    return undefined;
  }
  const currentBlock = input.currentBlocks.find((block) => block.id === input.conflict.blockId);
  const suggestedBlocks = buildSuggestedConflictDraftBlocks(input.currentBlocks, parsedOperations);
  if (!suggestedBlocks) {
    return undefined;
  }

  let incomingLabel = "冲突改动";
  let incomingContentMarkdown = "";
  if (focusedOperation.op === "replace_block") {
    incomingLabel = "冲突块内容";
    incomingContentMarkdown = focusedOperation.contentMarkdown;
  } else if (focusedOperation.op === "delete_block") {
    incomingLabel = "冲突删除动作";
    incomingContentMarkdown = "(该块会被删除)";
  } else if (focusedOperation.op === "insert_after") {
    incomingLabel = "冲突插入内容";
    incomingContentMarkdown = focusedOperation.contentMarkdown;
  }

  return {
    mode: "block",
    currentLabel: currentBlock?.heading ? `当前块 · ${currentBlock.heading}` : "当前块",
    currentContentMarkdown: currentBlock?.contentMarkdown ?? input.currentVersion?.contentMarkdown ?? "",
    incomingLabel,
    incomingContentMarkdown,
    suggestedDraftContentMarkdown: serializeConflictDraftBlocks(suggestedBlocks),
    suggestedDraftTitle: input.document?.title,
    suggestedDraftSummary: input.document?.summary,
  };
}

export function parseChannelDocumentChangeSetOperations(
  operationsJson: string | undefined,
): Array<
  | { op: "replace_document"; title?: string; contentMarkdown?: string; summary?: string }
  | { op: "replace_block"; blockId: string; contentMarkdown: string; heading?: string }
  | { op: "insert_after"; afterBlockId?: string; contentMarkdown: string; heading?: string }
  | { op: "delete_block"; blockId: string }
> {
  if (!operationsJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(operationsJson) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    const result: Array<
      | { op: "replace_document"; title?: string; contentMarkdown?: string; summary?: string }
      | { op: "replace_block"; blockId: string; contentMarkdown: string; heading?: string }
      | { op: "insert_after"; afterBlockId?: string; contentMarkdown: string; heading?: string }
      | { op: "delete_block"; blockId: string }
    > = [];

    for (const operation of parsed) {
      if (!operation || typeof operation !== "object") {
        continue;
      }
      const candidate = operation as {
        op?: unknown;
        title?: unknown;
        contentMarkdown?: unknown;
        summary?: unknown;
        blockId?: unknown;
        afterBlockId?: unknown;
        heading?: unknown;
      };
      if (candidate.op === "replace_document") {
        result.push({
          op: "replace_document",
          title: typeof candidate.title === "string" ? candidate.title : undefined,
          contentMarkdown: typeof candidate.contentMarkdown === "string" ? candidate.contentMarkdown : undefined,
          summary: typeof candidate.summary === "string" ? candidate.summary : undefined,
        });
        continue;
      }
      if (candidate.op === "replace_block" && typeof candidate.blockId === "string" && typeof candidate.contentMarkdown === "string") {
        result.push({
          op: "replace_block",
          blockId: candidate.blockId,
          contentMarkdown: candidate.contentMarkdown,
          heading: typeof candidate.heading === "string" ? candidate.heading : undefined,
        });
        continue;
      }
      if (candidate.op === "insert_after" && typeof candidate.contentMarkdown === "string") {
        result.push({
          op: "insert_after",
          afterBlockId: typeof candidate.afterBlockId === "string" ? candidate.afterBlockId : undefined,
          contentMarkdown: candidate.contentMarkdown,
          heading: typeof candidate.heading === "string" ? candidate.heading : undefined,
        });
        continue;
      }
      if (candidate.op === "delete_block" && typeof candidate.blockId === "string") {
        result.push({ op: "delete_block", blockId: candidate.blockId });
      }
    }

    return result;
  } catch {
    return [];
  }
}

export function buildSuggestedConflictDraftBlocks(
  blocks: ChannelDocumentBlock[],
  operations: ReturnType<typeof parseChannelDocumentChangeSetOperations>,
): ChannelDocumentBlock[] | null {
  const nextBlocks = blocks.map((block) => ({ ...block }));

  for (const operation of operations) {
    if (operation.op === "replace_block") {
      const index = nextBlocks.findIndex((block) => block.id === operation.blockId);
      if (index < 0) {
        return null;
      }
      nextBlocks[index] = {
        ...nextBlocks[index]!,
        heading: operation.heading ?? nextBlocks[index]!.heading,
        contentMarkdown: operation.contentMarkdown,
      };
      continue;
    }

    if (operation.op === "delete_block") {
      const index = nextBlocks.findIndex((block) => block.id === operation.blockId);
      if (index < 0) {
        return null;
      }
      nextBlocks.splice(index, 1);
      continue;
    }

    if (operation.op === "insert_after") {
      const insertIndex = operation.afterBlockId
        ? nextBlocks.findIndex((block) => block.id === operation.afterBlockId) + 1
        : 0;
      if (operation.afterBlockId && insertIndex <= 0) {
        return null;
      }
      const nextIndex = insertIndex < 0 ? nextBlocks.length : insertIndex;
      nextBlocks.splice(nextIndex, 0, {
        id: `preview-block-${nextIndex}`,
        documentId: nextBlocks[0]?.documentId ?? "",
        parentId: undefined,
        type: "section",
        order: nextIndex,
        heading: operation.heading,
        contentMarkdown: operation.contentMarkdown,
        revision: 0,
        updatedBy: "preview",
        updatedAt: new Date(0).toISOString(),
      });
      continue;
    }
  }

  return nextBlocks.map((block, index) => ({ ...block, order: index }));
}

export function serializeConflictDraftBlocks(blocks: ChannelDocumentBlock[]): string {
  return blocks
    .map((block) => block.contentMarkdown.trim())
    .filter((value) => value.length > 0)
    .join("\n\n");
}

export function summarizeChangeSetOperations(operationsJson: string): string {
  try {
    const parsed = JSON.parse(operationsJson) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return "未知改动";
    }

    const counts = new Map<string, number>();
    for (const operation of parsed) {
      if (!operation || typeof operation !== "object") {
        continue;
      }
      const op = typeof (operation as { op?: unknown }).op === "string" ? (operation as { op: string }).op : "unknown";
      counts.set(op, (counts.get(op) ?? 0) + 1);
    }

    if (counts.size === 0) {
      return "未知改动";
    }

    const labels: string[] = [];
    if (counts.has("replace_document")) {
      labels.push("整篇覆盖");
    }
    if (counts.has("replace_block")) {
      labels.push(`替换 ${counts.get("replace_block")} 个块`);
    }
    if (counts.has("insert_after")) {
      labels.push(`插入 ${counts.get("insert_after")} 个块`);
    }
    if (counts.has("delete_block")) {
      labels.push(`删除 ${counts.get("delete_block")} 个块`);
    }
    if (counts.has("unknown")) {
      labels.push(`其他变更 ${counts.get("unknown")}`);
    }

    return labels.join(" / ");
  } catch {
    return "未知改动";
  }
}

export function isRetryableChangeSetOperations(operationsJson: string): boolean {
  try {
    const parsed = JSON.parse(operationsJson) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return false;
    }
    return parsed.every((operation) => {
      if (!operation || typeof operation !== "object") {
        return false;
      }
      const candidate = operation as {
        op?: unknown;
        contentMarkdown?: unknown;
      };
      if (candidate.op === "replace_document") {
        return typeof candidate.contentMarkdown === "string";
      }
      if (candidate.op === "replace_block" || candidate.op === "insert_after") {
        return typeof candidate.contentMarkdown === "string";
      }
      return candidate.op === "delete_block";
    });
  } catch {
    return false;
  }
}
