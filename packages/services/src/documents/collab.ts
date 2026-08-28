import type {
  DofeAgentState,
  ChannelDocument,
  ChannelDocumentVersion,
} from "@dofe-agent/domain/workspace";
import type {
  ChannelDocumentAccess,
  ChannelDocumentBlock,
  ChannelDocumentChangeSet,
  ChannelDocumentConflict,
  ChannelDocumentPresence,
} from "@dofe-agent/domain";

export function rebuildChannelDocumentBlocksForVersion(input: {
  state: DofeAgentState;
  document: ChannelDocument;
  version: ChannelDocumentVersion;
  actorName: string;
}): void {
  const previousBlocks = listChannelDocumentBlocks(input.state, input.document.id);
  input.state.channelDocumentBlocks = input.state.channelDocumentBlocks.filter(
    (block) => block.documentId !== input.document.id,
  );

  const blocks = splitMarkdownIntoBlocks(input.version.contentMarkdown).map((block, index) => ({
    id: previousBlocks[index]?.id ?? `channel-doc-block-${createOpaqueId()}`,
    documentId: input.document.id,
    parentId: undefined,
    type: "section" as const,
    order: index,
    heading: block.heading,
    contentMarkdown: block.contentMarkdown,
    revision:
      previousBlocks[index] &&
      previousBlocks[index]!.heading === block.heading &&
      previousBlocks[index]!.contentMarkdown === block.contentMarkdown
        ? previousBlocks[index]!.revision
        : previousBlocks[index]
          ? previousBlocks[index]!.revision + 1
          : 1,
    updatedBy: input.actorName,
    updatedAt: input.version.createdAt,
  }));

  input.state.channelDocumentBlocks.push(...blocks);
}

export function listChannelDocumentBlocks(state: DofeAgentState, documentId: string): ChannelDocumentBlock[] {
  return state.channelDocumentBlocks
    .filter((block) => block.documentId === documentId)
    .sort((left, right) => left.order - right.order);
}

export function serializeChannelDocumentBlocks(blocks: ChannelDocumentBlock[]): string {
  return blocks.map((block) => block.contentMarkdown.trim()).filter((value) => value.length > 0).join("\n\n");
}

export function createChannelDocumentChangeSet(input: {
  documentId: string;
  actorId: string;
  actorType: "human" | "agent";
  baseVersionId: string;
  documentVersionId?: string;
  operationsJson: string;
  status: ChannelDocumentChangeSet["status"];
  sourceMessageId?: string;
  sourceTaskQueueId?: string;
  createdAt?: string;
}): ChannelDocumentChangeSet {
  return {
    id: `channel-doc-changeset-${createOpaqueId()}`,
    documentId: input.documentId,
    actorId: input.actorId,
    actorType: input.actorType,
    baseVersionId: input.baseVersionId,
    documentVersionId: input.documentVersionId?.trim() || undefined,
    operationsJson: input.operationsJson,
    status: input.status,
    sourceMessageId: input.sourceMessageId?.trim() || undefined,
    sourceTaskQueueId: input.sourceTaskQueueId?.trim() || undefined,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function createChannelDocumentConflict(input: {
  documentId: string;
  blockId: string;
  leftChangeSetId: string;
  rightChangeSetId: string;
  createdAt?: string;
}): ChannelDocumentConflict {
  return {
    id: `channel-doc-conflict-${createOpaqueId()}`,
    documentId: input.documentId,
    blockId: input.blockId,
    leftChangeSetId: input.leftChangeSetId,
    rightChangeSetId: input.rightChangeSetId,
    status: "open",
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function normalizeChannelDocumentBlocks(
  blocks: DofeAgentState["channelDocumentBlocks"] | undefined,
  fallback: DofeAgentState["channelDocumentBlocks"],
): DofeAgentState["channelDocumentBlocks"] {
  if (!Array.isArray(blocks)) {
    return fallback;
  }

  return blocks
    .map((block) => normalizeChannelDocumentBlock(block))
    .filter((block): block is ChannelDocumentBlock => block !== null)
    .sort((left, right) => {
      if (left.documentId !== right.documentId) {
        return left.documentId.localeCompare(right.documentId, "en-US", { sensitivity: "base" });
      }
      return left.order - right.order;
    });
}

export function normalizeChannelDocumentAccesses(
  accesses: DofeAgentState["channelDocumentAccesses"] | undefined,
  fallback: DofeAgentState["channelDocumentAccesses"],
): DofeAgentState["channelDocumentAccesses"] {
  if (!Array.isArray(accesses)) {
    return fallback;
  }

  return accesses
    .map((access) => normalizeChannelDocumentAccess(access))
    .filter((access): access is ChannelDocumentAccess => access !== null)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

export function normalizeChannelDocumentChangeSets(
  changeSets: DofeAgentState["channelDocumentChangeSets"] | undefined,
  fallback: DofeAgentState["channelDocumentChangeSets"],
): DofeAgentState["channelDocumentChangeSets"] {
  if (!Array.isArray(changeSets)) {
    return fallback;
  }

  return changeSets
    .map((changeSet) => normalizeChannelDocumentChangeSet(changeSet))
    .filter((changeSet): changeSet is ChannelDocumentChangeSet => changeSet !== null)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function normalizeChannelDocumentConflicts(
  conflicts: DofeAgentState["channelDocumentConflicts"] | undefined,
  fallback: DofeAgentState["channelDocumentConflicts"],
): DofeAgentState["channelDocumentConflicts"] {
  if (!Array.isArray(conflicts)) {
    return fallback;
  }

  return conflicts
    .map((conflict) => normalizeChannelDocumentConflict(conflict))
    .filter((conflict): conflict is ChannelDocumentConflict => conflict !== null)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

export function normalizeChannelDocumentPresences(
  presences: DofeAgentState["channelDocumentPresences"] | undefined,
  fallback: DofeAgentState["channelDocumentPresences"],
): DofeAgentState["channelDocumentPresences"] {
  if (!Array.isArray(presences)) {
    return fallback;
  }

  return presences
    .map((presence) => normalizeChannelDocumentPresence(presence))
    .filter((presence): presence is ChannelDocumentPresence => presence !== null)
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
}

function splitMarkdownIntoBlocks(contentMarkdown: string): Array<{ heading?: string; contentMarkdown: string }> {
  const sections = contentMarkdown
    .split(/\n(?=##?\s)/)
    .map((section) => section.trim())
    .filter((section) => section.length > 0);

  if (sections.length === 0) {
    return [
      {
        heading: undefined,
        contentMarkdown,
      },
    ];
  }

  return sections.map((section) => {
    const firstLine = section.split(/\r?\n/, 1)[0] ?? "";
    return {
      heading: /^#+\s+/.test(firstLine) ? firstLine.replace(/^#+\s+/, "").trim() : undefined,
      contentMarkdown: section,
    };
  });
}

function normalizeChannelDocumentBlock(block: unknown): ChannelDocumentBlock | null {
  if (!block || typeof block !== "object") {
    return null;
  }

  const candidate = block as Partial<ChannelDocumentBlock>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.documentId !== "string" ||
    typeof candidate.order !== "number" ||
    typeof candidate.contentMarkdown !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    documentId: candidate.documentId,
    parentId: typeof candidate.parentId === "string" ? candidate.parentId : undefined,
    type: "section",
    order: candidate.order,
    heading: typeof candidate.heading === "string" ? candidate.heading : undefined,
    contentMarkdown: candidate.contentMarkdown,
    revision: typeof candidate.revision === "number" ? candidate.revision : 1,
    updatedBy: typeof candidate.updatedBy === "string" ? candidate.updatedBy : "Unknown",
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
  };
}

function normalizeChannelDocumentAccess(access: unknown): ChannelDocumentAccess | null {
  if (!access || typeof access !== "object") {
    return null;
  }

  const candidate = access as Partial<ChannelDocumentAccess>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.documentId !== "string" ||
    typeof candidate.actorId !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    documentId: candidate.documentId,
    actorId: candidate.actorId,
    actorType: candidate.actorType === "agent" ? "agent" : "human",
    role: candidate.role === "owner" || candidate.role === "viewer" ? candidate.role : "editor",
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date(0).toISOString(),
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
  };
}

function normalizeChannelDocumentChangeSet(changeSet: unknown): ChannelDocumentChangeSet | null {
  if (!changeSet || typeof changeSet !== "object") {
    return null;
  }

  const candidate = changeSet as Partial<ChannelDocumentChangeSet>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.documentId !== "string" ||
    typeof candidate.actorId !== "string" ||
    typeof candidate.baseVersionId !== "string" ||
    typeof candidate.operationsJson !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    documentId: candidate.documentId,
    actorId: candidate.actorId,
    actorType: candidate.actorType === "agent" ? "agent" : "human",
    baseVersionId: candidate.baseVersionId,
    documentVersionId: typeof candidate.documentVersionId === "string" ? candidate.documentVersionId : undefined,
    operationsJson: candidate.operationsJson,
    status:
      candidate.status === "applied" || candidate.status === "conflicted" || candidate.status === "rejected"
        ? candidate.status
        : "pending",
    sourceMessageId: typeof candidate.sourceMessageId === "string" ? candidate.sourceMessageId : undefined,
    sourceTaskQueueId: typeof candidate.sourceTaskQueueId === "string" ? candidate.sourceTaskQueueId : undefined,
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date(0).toISOString(),
  };
}

function normalizeChannelDocumentConflict(conflict: unknown): ChannelDocumentConflict | null {
  if (!conflict || typeof conflict !== "object") {
    return null;
  }

  const candidate = conflict as Partial<ChannelDocumentConflict>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.documentId !== "string" ||
    typeof candidate.blockId !== "string" ||
    typeof candidate.leftChangeSetId !== "string" ||
    typeof candidate.rightChangeSetId !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    documentId: candidate.documentId,
    blockId: candidate.blockId,
    leftChangeSetId: candidate.leftChangeSetId,
    rightChangeSetId: candidate.rightChangeSetId,
    status: candidate.status === "resolved" ? "resolved" : "open",
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date(0).toISOString(),
  };
}

function normalizeChannelDocumentPresence(presence: unknown): ChannelDocumentPresence | null {
  if (!presence || typeof presence !== "object") {
    return null;
  }

  const candidate = presence as Partial<ChannelDocumentPresence>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.documentId !== "string" ||
    typeof candidate.actorId !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    documentId: candidate.documentId,
    actorId: candidate.actorId,
    actorType: candidate.actorType === "agent" ? "agent" : "human",
    status:
      candidate.status === "editing" || candidate.status === "processing" ? candidate.status : "viewing",
    updatedAt: typeof candidate.updatedAt === "string" ? candidate.updatedAt : new Date(0).toISOString(),
  };
}

function createOpaqueId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
