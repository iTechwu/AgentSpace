import type {
  DofeAgentState,
  ChannelRecord,
  ChannelDocument,
  ChannelDocumentVersion,
  MessageAttachment,
  WorkspaceMessage,
} from "@dofe-agent/domain/workspace";
import { sameValue, sanitizeAttachmentFileName } from "../shared/helpers.ts";
import { resolveChannelHumanMemberNames } from "../channels/channels.ts";
import { readWorkspaceAttachmentBytesSync } from "../attachments/attachments.ts";

export function findWorkspaceAttachmentById(
  state: DofeAgentState,
  attachmentId: string,
): { attachment: MessageAttachment; message?: WorkspaceMessage } | null {
  for (const message of state.messages) {
    const attachment = message.attachments?.find((item) => item.id === attachmentId);
    if (attachment) {
      return { attachment, message };
    }
  }
  return null;
}

export function assertCanAccessWorkspaceAttachment(
  state: DofeAgentState,
  attachmentId: string,
  actorId: string,
  actorType: "human" | "agent",
): { attachment: MessageAttachment; message?: WorkspaceMessage } {
  const match = findWorkspaceAttachmentById(state, attachmentId);
  if (!match) {
    throw new Error(`Attachment "${attachmentId}" does not exist.`);
  }

  const channelName = match.message?.channel?.trim();
  if (!channelName) {
    return match;
  }

  if (actorType === "human") {
    if (canHumanActorAccessChannel(state, channelName, actorId)) {
      return match;
    }
  } else if (canAgentActorAccessChannel(state, channelName, actorId)) {
    return match;
  }

  throw new Error(`Actor "${actorId}" cannot access attachment "${attachmentId}".`);
}

export function createAttachmentFromChannelDocumentVersion(input: {
  document: ChannelDocument;
  version: ChannelDocumentVersion;
  persistAttachment: (input: { contentBytes: Uint8Array; fileName: string; mediaType: string }) => MessageAttachment;
}): MessageAttachment {
  const isMarkdown = input.document.kind === "markdown";
  const fileName = sanitizeAttachmentFileName(`${input.document.slug || input.document.title}.${isMarkdown ? "md" : "json"}`);
  const content = isMarkdown
    ? input.version.contentMarkdown
    : JSON.stringify(input.version.contentJson ?? { contentMarkdown: input.version.contentMarkdown }, null, 2);
  return input.persistAttachment({
    contentBytes: Buffer.from(content, "utf8"),
    fileName,
    mediaType: isMarkdown ? "text/markdown" : "application/json",
  });
}

export function readMarkdownAttachmentContent(
  attachment: MessageAttachment,
): string {
  return Buffer.from(readWorkspaceAttachmentBytesSync(attachment)).toString("utf8");
}

function canHumanActorAccessChannel(
  state: DofeAgentState,
  channelName: string,
  actorId: string,
): boolean {
  const channel = findChannelRecord(state, channelName);
  if (!channel) {
    return false;
  }

  const visibleHumanNames = resolveChannelHumanMemberNames(state, channel);

  return visibleHumanNames.some((name) => sameValue(name, actorId));
}

function canAgentActorAccessChannel(
  state: DofeAgentState,
  channelName: string,
  actorId: string,
): boolean {
  const employee = state.activeEmployees.find((item) => sameValue(item.name, actorId));
  return Boolean(employee?.channels.some((channel) => sameValue(channel, channelName)));
}

function findChannelRecord(state: DofeAgentState, channelName: string): ChannelRecord | undefined {
  return state.channels.find((channel) => sameValue(channel.name, channelName));
}
