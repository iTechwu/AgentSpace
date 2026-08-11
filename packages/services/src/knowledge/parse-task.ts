/**
 * 文件解析任务编排：
 * 1. 把上传的字节流保存到 TOS，生成 attachment 记录；
 * 2. 同步创建一条 capability_request（requested_action='parse'、status='running'）作为任务信封；
 * 3. 在返回前启动 fire-and-forget 解析 Promise：
 *    - 成功：createKnowledgePageSync(contentMarkdown=解析结果) → transitionCapabilityRequestSync('completed', linkedKnowledgePageId=...)
 *    - 失败：transitionCapabilityRequestSync('failed', lastErrorCode/Message)
 * 4. 上层（API route）拿到 taskId 后直接返回，UI 通过 capability_request 列表 + 2.5s 轮询看到进度。
 *
 * 之所以用 fire-and-forget 而不是常驻 worker：解析属于一次性、低频（用户主动触发）的副作用，
 * capability_request 的 'running' 行就是事实上的"任务队列"，进程崩溃后用 stuck_at + reaper 兜底是后续事项。
 */
import { createKnowledgePageSync, listKnowledgePagesSync } from "./knowledge.ts";
import { persistWorkspaceAttachmentFromBytesSync, readWorkspaceAttachmentBytesSync } from "../attachments/attachments.ts";
import {
  createCapabilityRequestSync,
  listCapabilityRequestsSync,
  transitionCapabilityRequestSync,
} from "@dofe-agent/db";
import { parseFileToMarkdown, type ParseFailure, type ParseResult } from "../document-parsing/parse-file.ts";

export type FileParseIntent = "auto_deposit" | "document_only";

export interface SubmitFileParseTaskInput {
  workspaceId?: string;
  /** 上传者 userId（用于 capability_request.requestedByUserId 与 knowledge_page.createdBy 关联） */
  requestedByUserId: string;
  /** 上传者展示名，写入 knowledge_page.createdBy */
  requestedByDisplayName: string;
  contentBytes: Uint8Array;
  fileName: string;
  mediaType?: string;
  intent: FileParseIntent;
  message?: string;
}

export interface SubmitFileParseTaskResult {
  capabilityRequestId: string;
  attachmentId: string;
  status: "running" | "completed" | "failed";
}

export function submitFileParseTaskSync(
  input: SubmitFileParseTaskInput,
): SubmitFileParseTaskResult {
  const workspaceId = input.workspaceId;
  if (input.contentBytes.byteLength === 0) {
    throw new Error("上传文件为空。");
  }

  // 1. TOS 持久化
  const attachment = persistWorkspaceAttachmentFromBytesSync({
    workspaceId,
    contentBytes: input.contentBytes,
    fileName: input.fileName,
    mediaType: input.mediaType,
  });

  // 2. 用 attachment.id 作为 capability_request 的包标识（slug+source），便于 dedup 唯一约束
  const request = createCapabilityRequestSync({
    workspaceId,
    requestedByUserId: input.requestedByUserId,
    packageKind: "service",
    packageSource: "knowledge-upload",
    packageSlug: attachment.id,
    packageDisplayName: input.fileName,
    deploymentMode: "managed_service",
    requestedAction: "parse",
    priority: "normal",
    message: input.message ?? "",
    metadataJson: JSON.stringify({
      attachmentId: attachment.id,
      attachmentStoredPath: attachment.storedPath,
      mediaType: input.mediaType ?? attachment.mediaType ?? "application/octet-stream",
      sizeBytes: attachment.sizeBytes ?? input.contentBytes.byteLength,
      intent: input.intent,
      fileName: input.fileName,
    }),
  });

  // 立刻置为 running（信令侧不需要 pending 审批）
  transitionCapabilityRequestSync({
    requestId: request.id,
    workspaceId,
    status: "running",
  });

  // 3. fire-and-forget 解析
  if (input.intent === "auto_deposit") {
    runParseAndCreatePage({
      requestId: request.id,
      workspaceId,
      attachmentId: attachment.id,
      fileName: input.fileName,
      mediaType: input.mediaType,
      contentBytes: input.contentBytes,
      requestedByUserId: input.requestedByUserId,
      requestedByDisplayName: input.requestedByDisplayName,
    });
  } else {
    runParseOnly({
      requestId: request.id,
      workspaceId,
      attachmentId: attachment.id,
      fileName: input.fileName,
      mediaType: input.mediaType,
      contentBytes: input.contentBytes,
    });
  }

  return {
    capabilityRequestId: request.id,
    attachmentId: attachment.id,
    status: "running",
  };
}

interface RunParseArgs {
  requestId: string;
  workspaceId?: string;
  attachmentId: string;
  fileName: string;
  mediaType?: string;
  contentBytes: Uint8Array;
  requestedByUserId?: string;
  requestedByDisplayName?: string;
}

function runParseAndCreatePage(input: RunParseArgs): void {
  void (async () => {
    try {
      const result = await parseFileToMarkdown(input.contentBytes, input.fileName, input.mediaType);
      createKnowledgePageSync({
        title: deriveTitleFromFileName(input.fileName),
        contentMarkdown: result.markdown || `_（文件 ${input.fileName} 解析后没有可用文字，仅保留附件）_`,
        tags: ["imported-from-upload"],
        createdBy: input.requestedByDisplayName ?? input.requestedByUserId ?? "system",
        sourceAttachmentId: input.attachmentId,
      }, input.workspaceId);
      const createdPage = listKnowledgePagesSync(input.workspaceId)
        .slice()
        .reverse()
        .find((page) => page.sourceAttachmentId === input.attachmentId);
      transitionCapabilityRequestSync({
        requestId: input.requestId,
        workspaceId: input.workspaceId,
        status: "completed",
        linkedKnowledgePageId: createdPage?.id,
        metadataJson: JSON.stringify({
          warnings: result.warnings,
          detectedKind: result.detectedKind,
          detectedMediaType: result.detectedMediaType,
        }),
      });
    } catch (error) {
      const failure = asParseFailure(error);
      transitionCapabilityRequestSync({
        requestId: input.requestId,
        workspaceId: input.workspaceId,
        status: "failed",
        lastErrorCode: failure.code ?? "parser_error",
        lastErrorMessage: failure.message,
      });
    }
  })();
}

function runParseOnly(input: RunParseArgs): void {
  void (async () => {
    try {
      const bytes = input.contentBytes.byteLength > 0
        ? input.contentBytes
        : readWorkspaceAttachmentBytesSync({ storedPath: "" } as never);
      const result = await parseFileToMarkdown(bytes, input.fileName, input.mediaType);
      transitionCapabilityRequestSync({
        requestId: input.requestId,
        workspaceId: input.workspaceId,
        status: "completed",
        metadataJson: JSON.stringify({
          warnings: result.warnings,
          detectedKind: result.detectedKind,
          detectedMediaType: result.detectedMediaType,
          previewText: result.markdown.slice(0, 1000),
        }),
      });
    } catch (error) {
      const failure = asParseFailure(error);
      transitionCapabilityRequestSync({
        requestId: input.requestId,
        workspaceId: input.workspaceId,
        status: "failed",
        lastErrorCode: failure.code ?? "parser_error",
        lastErrorMessage: failure.message,
      });
    }
  })();
}

function deriveTitleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "").trim();
  return base.length > 0 ? base : fileName;
}

function asParseFailure(error: unknown): ParseFailure {
  if (error && typeof error === "object" && "code" in error) {
    return error as ParseFailure;
  }
  const fallback: ParseFailure = Object.assign(
    new Error(error instanceof Error ? error.message : String(error)),
    { code: "parser_error" as const },
  );
  return fallback;
}

/** running 状态超过该时长视为卡住（进程崩溃/重启后 fire-and-forget 解析无法收尾）。 */
const STUCK_PARSE_TASK_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * 兜底回收：把"卡住"的解析任务（requested_action='parse' 且 status='running'，
 * 且 updatedAt 早于 maxAgeMs）标记为 failed。fire-and-forget 解析在进程崩溃或
 * 重启时会留下永久的 running 行，知识页加载时调用本函数扫一遍，避免 UI 永远转圈。
 *
 * 返回本次被回收的任务数量。
 */
export function reapStuckParseTasksSync(
  workspaceId: string | undefined,
  maxAgeMs: number = STUCK_PARSE_TASK_MAX_AGE_MS,
): number {
  const running = listCapabilityRequestsSync({
    workspaceId,
    packageKind: "service",
    statuses: ["running"],
    limit: 200,
  }).filter((request) => request.requestedAction === "parse");
  if (running.length === 0) {
    return 0;
  }
  const now = Date.now();
  let reaped = 0;
  for (const request of running) {
    const updatedAtMs = new Date(request.updatedAt).getTime();
    // updatedAt 非法或未超阈值则跳过。
    if (!Number.isFinite(updatedAtMs) || now - updatedAtMs < maxAgeMs) {
      continue;
    }
    transitionCapabilityRequestSync({
      requestId: request.id,
      workspaceId,
      status: "failed",
      lastErrorCode: "parse_task_stuck",
      lastErrorMessage: `解析任务已运行超过 ${Math.round(maxAgeMs / 1000)}s 仍为 running，疑似进程中断，已自动标记为失败。`,
    });
    reaped += 1;
  }
  return reaped;
}
