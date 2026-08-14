// 频道文档访问种子：纯函数，按频道成员推导文档默认访问记录。
// 下沉 shared 层供 state-io（读写快照路径）与 documents/access 共享，
// 保持 state-io 不再反向依赖 documents 域（依赖单向：域 → shared）。
import { type ChannelDocumentAccessRole } from "@dofe-agent/domain";
import type { ChannelDocument, DofeAgentState } from "@dofe-agent/domain/workspace";
import { sameValue } from "./helpers.ts";
import { resolveChannelHumanMemberNames } from "./channel-members.ts";

export function ensureChannelDocumentAccessSeeds(state: DofeAgentState): boolean {
  let changed = false;

  for (const document of state.channelDocuments) {
    const existing = state.channelDocumentAccesses.filter((access) => access.documentId === document.id);
    if (existing.length > 0) {
      continue;
    }

    state.channelDocumentAccesses.unshift(...buildDefaultDocumentAccesses(state, document));
    changed = true;
  }

  return changed;
}

function buildDefaultDocumentAccesses(
  state: DofeAgentState,
  document: ChannelDocument,
): DofeAgentState["channelDocumentAccesses"] {
  const now = document.createdAt;
  const result: DofeAgentState["channelDocumentAccesses"] = [];
  const seen = new Set<string>();
  const channel = state.channels.find((item) => sameValue(item.name, document.channelName));
  const humanMemberNames = channel
    ? resolveChannelHumanMemberNames(state, channel)
    : state.humanMembers.map((member) => member.name);

  const ownerHuman =
    humanMemberNames.find((name) => sameValue(name, document.createdBy)) ?? humanMemberNames[0];
  if (ownerHuman) {
    result.push(createDocumentAccess(document.id, ownerHuman, "human", "owner", now));
    seen.add(`human:${ownerHuman.toLocaleLowerCase("zh-CN")}`);
  } else if (state.activeEmployees.some((employee) => sameValue(employee.name, document.createdBy))) {
    result.push(createDocumentAccess(document.id, document.createdBy, "agent", "editor", now));
    seen.add(`agent:${document.createdBy.toLocaleLowerCase("zh-CN")}`);
  }

  for (const memberName of humanMemberNames) {
    const key = `human:${memberName.toLocaleLowerCase("zh-CN")}`;
    if (seen.has(key)) {
      continue;
    }
    result.push(createDocumentAccess(document.id, memberName, "human", "editor", now));
    seen.add(key);
  }

  for (const employee of state.activeEmployees) {
    if (!employee.channels.some((channel) => sameValue(channel, document.channelName)) && !sameValue(employee.name, document.createdBy)) {
      continue;
    }
    const key = `agent:${employee.name.toLocaleLowerCase("zh-CN")}`;
    if (seen.has(key)) {
      continue;
    }
    result.push(createDocumentAccess(document.id, employee.name, "agent", "editor", now));
    seen.add(key);
  }

  return result;
}

function createDocumentAccess(
  documentId: string,
  actorId: string,
  actorType: "human" | "agent",
  role: ChannelDocumentAccessRole,
  now: string,
): DofeAgentState["channelDocumentAccesses"][number] {
  return {
    id: `channel-doc-access-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    documentId,
    actorId,
    actorType,
    role,
    createdAt: now,
    updatedAt: now,
  };
}
