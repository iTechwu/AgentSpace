// 会话线程的数据模型与纯函数（从 conversation-shell.tsx 拆出，3.4-2）：
// 类型 + 排序/匹配/草稿编辑/slash 命令构造，全部无 React 依赖。

import type { GeneratedAvatarVariant } from "@/shared/ui/generated-avatar";
import type { MessageAcknowledgement, MessageAttachment, MessageMention } from "@/shared/types/workspace";
import type { EmployeeExecutionPolicy } from "@dofe-agent/domain/workspace";
import type { ExecutionTimelineItem } from "@/features/chat/task-execution-timeline";

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
  /** Raw runtime thinking/tool detail retained for process-message fallback rendering. */
  executionDetail?: string;
  timestamp: string;
  status: "pending" | "completed" | "error";
  attachments?: MessageAttachment[];
  mentions?: MessageMention[];
  acknowledgements?: MessageAcknowledgement[];
  kind?: "message" | "process";
  processType?: string;
  tool?: string;
  /** Structured execution timeline for a task-bound process group (replaces flat process cards). */
  execution?: ExecutionTimelineItem[];
  executionRunning?: boolean;
  /** Agent reply that belongs to an execution group; rendered attached to the timeline card. */
  executionGrouped?: boolean;
  /** Final agent reply rendered inside the task's execution card. */
  executionReply?: ConversationThreadMessage;
  pinned?: boolean;
  pinnedAt?: string;
  replyToMessageId?: string;
  deliveryStatus?: "sending" | "sent" | "failed";
  /** Stable ISO timestamp used when supplementary content is interleaved. */
  sortTimestamp?: string;
}

export interface OptimisticConversationMessage extends ConversationThreadMessage {
  conversationId: string;
  serverMessageIdsAtSubmission: string[];
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
  action: "model" | "resume" | "new" | "clear" | "permissions" | "claude-plan" | "claude-auto" | "codex-review";
}

export interface SelectedComposerReference {
  id: string;
  label: string;
  kind: "file" | "skill";
  sourceId: string;
}

export interface QueuedConversationMessage {
  id: string;
  content: string;
  replyToMessageId?: string;
  createdAt: string;
  referenceAttachmentIds?: string[];
  referenceSkillIds?: string[];
}

export function orderConversationMessages(messages: ConversationThreadMessage[]): ConversationThreadMessage[] {
  const hasActiveAgentMessages = messages.some((message) => getConversationMessageActivityPriority(message) > 0);
  if (!hasActiveAgentMessages) {
    return messages;
  }

  // Process records remain in their audit order; the live agent reply stays visible at the end.
  return [...messages].sort(
    (left, right) => getConversationMessageActivityPriority(left) - getConversationMessageActivityPriority(right),
  );
}

export function isOwnHumanMessage(
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

export function hasServerMessageCopy(
  optimisticMessage: OptimisticConversationMessage,
  serverMessages: ConversationThreadMessage[],
): boolean {
  const existingMessageIds = new Set(optimisticMessage.serverMessageIdsAtSubmission);
  return serverMessages.some((serverMessage) => (
    !existingMessageIds.has(serverMessage.id) &&
    serverMessage.role === "human" &&
    serverMessage.content === optimisticMessage.content &&
    serverMessage.replyToMessageId === optimisticMessage.replyToMessageId
  ));
}

export function buildReplyMentionPrefix(
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

export function findDraftSlashQuery(draft: string, caretIndex: number): { start: number; query: string } | null {
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

export function replaceDraftRange(
  draft: string,
  start: number,
  end: number,
  replacement: string,
): { value: string; caretIndex: number } {
  const value = `${draft.slice(0, start)}${replacement}${draft.slice(end)}`;
  return { value, caretIndex: start + replacement.length };
}

export function buildComposerSlashCommands(
  provider: ConversationComposerRuntime["provider"] | undefined,
  tx: (zh: string, en: string) => string,
): ConversationSlashCommand[] {
  const commands: ConversationSlashCommand[] = [
    {
      id: "model",
      command: "/model",
      label: tx("切换模型", "Switch model"),
      description: tx("为当前会话选择模型", "Choose a model for this conversation"),
      action: "model",
    },
  ];
  if (provider) {
    commands.push({
      id: "resume",
      command: "/resume",
      label: tx("继续会话", "Resume session"),
      description: tx("沿用当前运行时会话继续处理", "Continue with the current runtime session"),
      action: "resume",
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
  commands.push({
    id: "new",
    command: "/new",
    label: tx("新开会话", "New conversation"),
    description: tx("保留当前会话并开始一个空白会话", "Keep this conversation and start a blank one"),
    action: "new",
  });
  return commands;
}

export function resolveSubmittedSlashCommand(
  draft: string,
  provider: ConversationComposerRuntime["provider"] | undefined,
  tx: (zh: string, en: string) => string,
): ConversationSlashCommand | undefined {
  const commandToken = draft.trim().split(/\s+/, 1)[0]?.toLocaleLowerCase("zh-CN");
  if (!commandToken?.startsWith("/")) {
    return undefined;
  }
  return buildComposerSlashCommands(provider, tx).find(
    (command) => command.command.toLocaleLowerCase("zh-CN") === commandToken,
  );
}

export function policyForSlashCommand(action: ConversationSlashCommand["action"]): EmployeeExecutionPolicy | undefined {
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

function getConversationMessageActivityPriority(message: ConversationThreadMessage): number {
  if (message.role !== "agent" || message.status !== "pending") {
    return 0;
  }
  return message.kind === "process" ? 1 : 2;
}
