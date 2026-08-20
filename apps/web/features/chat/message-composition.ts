// 消息组合助手：附件引用解析、附件合并、技能指令追加。
// 供 server action（features/channels/actions.ts）与 REST 路由
// （app/api/workspaces/[workspaceId]/conversations/[conversationId]/messages）复用。
// 独立成模块以避免从 "use server" 文件导出同步函数（Next.js 仅允许导出 async 函数）。

import type { MessageAttachment } from "@dofe-agent/domain/workspace";
import { readWorkspaceStateSync, sameValue } from "@dofe-agent/services/workspace";
import { listEmployeeSkillIdsSync } from "@dofe-agent/services/employees";
import { listWorkspaceSkillsSync } from "@dofe-agent/services/skills";

export function resolveReferencedAttachments(input: {
  workspaceId: string;
  channelName?: string;
  attachmentIds: string[];
  conversationId?: string;
}): MessageAttachment[] {
  if (input.attachmentIds.length === 0) {
    return [];
  }
  const requestedIds = new Set(input.attachmentIds);
  const attachmentsById = new Map<string, MessageAttachment>();
  for (const message of readWorkspaceStateSync(input.workspaceId).messages) {
    if (input.channelName && !sameValue(message.channel ?? "", input.channelName)) {
      continue;
    }
    // 会话作用域：引用附件必须属于目标 Conversation（REST 端点按 conversationId 过滤）。
    if (input.conversationId && message.conversationId !== input.conversationId) {
      continue;
    }
    for (const attachment of message.attachments ?? []) {
      if (requestedIds.has(attachment.id) && !attachment.deletedAt && !attachmentsById.has(attachment.id)) {
        attachmentsById.set(attachment.id, attachment);
      }
    }
  }
  return input.attachmentIds.map((attachmentId) => {
    const attachment = attachmentsById.get(attachmentId);
    if (!attachment) {
      throw new Error(`Attachment "${attachmentId}" does not exist${input.channelName ? ` in channel "${input.channelName}"` : ""}.`);
    }
    const { deletedAt: _deletedAt, deletedByDisplayName: _deletedByDisplayName, deletedByUserId: _deletedByUserId, ...activeAttachment } = attachment;
    return {
      ...activeAttachment,
      id: `att-ref-${crypto.randomUUID()}`,
    };
  });
}

export function mergeMessageAttachments(
  uploaded: MessageAttachment[] | undefined,
  referenced: MessageAttachment[],
): MessageAttachment[] | undefined {
  const attachments = [...(uploaded ?? []), ...referenced];
  return attachments.length > 0 || uploaded !== undefined ? attachments : undefined;
}

export function appendReferencedSkillDirective(input: {
  workspaceId: string;
  employeeNames: string[];
  content: string;
  skillIds: string[];
}): string {
  if (input.skillIds.length === 0) {
    return input.content;
  }
  const allowedSkillIds = new Set(
    input.employeeNames.flatMap((employeeName) => listEmployeeSkillIdsSync(employeeName, input.workspaceId)),
  );
  const skillsById = new Map(listWorkspaceSkillsSync(input.workspaceId).map((skill) => [skill.id, skill]));
  const skillNames = input.skillIds.map((skillId) => {
    const skill = skillsById.get(skillId);
    if (!skill || !allowedSkillIds.has(skillId)) {
      throw new Error(`Skill "${skillId}" is not assigned to the selected employee.`);
    }
    return skill.name;
  });
  return `${input.content.trim()}

[Use assigned skills: ${skillNames.join(", ")}]`;
}
