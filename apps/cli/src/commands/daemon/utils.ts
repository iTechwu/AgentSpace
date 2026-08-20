// daemon CLI 的任务/路径/恢复快照纯工具（从 commands/daemon.ts 拆出，3.6 巨型文件项）。

import { HttpDaemonClient } from "../../lib/daemon-client.ts";
import { getDaemonChannelWorkDirPath, getDaemonRemoteTaskWorkDirPath, getDaemonTaskWorkDirPath } from "@dofe-agent/db";
import type { QueuedTaskRecord } from "@dofe-agent/db";
import { chmodSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDaemonStateDir } from "./lifecycle.ts";

export function toQueuedTaskRecord(task: Awaited<ReturnType<HttpDaemonClient["claimTask"]>>["task"]): QueuedTaskRecord {
  if (!task) {
    throw new Error("Cannot map an empty claimed task.");
  }

  return {
    id: task.id,
    workspaceId: task.workspaceId,
    employeeId: task.employeeId ?? task.agentId,
    employeeName: task.employeeName ?? task.agentId,
    agentId: task.employeeName ?? task.agentId,
    runtimeId: task.runtimeId,
    routerSessionId: task.routerSessionId,
    triggerType: task.triggerType,
    priority: task.priority,
    status: task.status as QueuedTaskRecord["status"],
    inputJson: task.inputJson,
    queuedAt: task.queuedAt,
    createdAt: task.queuedAt,
    updatedAt: task.queuedAt,
  };
}
export function sameValue(left: string, right: string): boolean {
  return left.localeCompare(right, "zh-CN", { sensitivity: "base" }) === 0;
}
export function normalizeSkillFilePath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("/");
}
export function getWorkspaceRemoteTaskWorkDir(workspaceId: string, taskId: string): string {
  return getDaemonRemoteTaskWorkDirPath(ensureDaemonStateDir(), { workspaceId, taskId });
}
export function resolveConversationThreadId(input: {
  triggerType: string;
  payload: {
    channel?: string;
    channelName?: string;
    contactId?: string;
    conversationId?: string;
  };
}): string | undefined {
  const isConversationTrigger = input.triggerType === "channel_chat" || input.triggerType === "mention_chat";
  if (!isConversationTrigger && !input.payload.contactId) {
    return undefined;
  }

  // 会话拆分：有 conversationId 时，workDir 按 Conversation 隔离，不按频道共享（docs §4.2）。
  if (input.payload.conversationId) {
    return `conversation:${input.payload.conversationId}`;
  }
  return input.payload.channelName ?? input.payload.channel;
}
export function resolveWorkspaceTaskWorkDir(input: {
  workspaceId: string;
  taskId: string;
  agentId: string;
  channelThreadId?: string;
}): string {
  if (input.channelThreadId) {
    return getDaemonChannelWorkDirPath(ensureDaemonStateDir(), {
      workspaceId: input.workspaceId,
      threadId: input.channelThreadId,
      agentId: input.agentId,
    });
  }

  return getDaemonTaskWorkDirPath(ensureDaemonStateDir(), {
    workspaceId: input.workspaceId,
    taskId: input.taskId,
  });
}
export function persistLocalCompletionRecoverySnapshot(input: {
  stagingDir: string;
  workDir: string;
  workDirFiles: Array<{ path: string; bytes: Uint8Array; mode?: string }>;
  deletedPaths: string[];
  snapshot: unknown;
}): void {
  rmSync(input.stagingDir, { recursive: true, force: true });
  mkdirSync(input.stagingDir, { recursive: true });
  for (const file of input.workDirFiles) {
    const targetPath = join(input.stagingDir, file.path);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, file.bytes);
    if (file.mode && /^[0-7]{3,4}$/.test(file.mode)) {
      chmodSync(targetPath, Number.parseInt(file.mode, 8));
    }
  }
  const runtimeOutputDir = join(input.workDir, "runtime-output");
  if (existsSync(runtimeOutputDir)) {
    cpSync(runtimeOutputDir, join(input.stagingDir, "runtime-output"), { recursive: true });
  }
  if (input.deletedPaths.length > 0) {
    writeFileSync(
      join(input.stagingDir, ".workdir-deleted.json"),
      JSON.stringify({ deletedPaths: input.deletedPaths }),
      { encoding: "utf8", mode: 0o600 },
    );
  }
  const snapshotPath = join(input.stagingDir, ".completion-effects.json");
  const temporaryPath = `${snapshotPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(input.snapshot), { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, snapshotPath);
}
