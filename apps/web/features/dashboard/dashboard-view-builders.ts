// Dashboard 各域 loader 共用的纯视图构建 helper：频道列表/会话/文档视图模型、
// 提及未读检测、附件引用索引、知识文档记录等。仅依赖 ./data-types 与外部包，
// 保持 data.ts -> 本模块 的单向依赖。
import { cache } from "react";
import {
  basename,
} from "node:path";
import {
  canReadChannelForActorSync,
  inferAttachmentKind,
  readWorkspaceAttachmentBytesSync,
  resolveAttachmentMediaType,
  resolveChannelHumanMemberNames,
} from "@dofe-agent/services";
import {
  listQueuedTasksSync,
} from "@dofe-agent/db";
import type {
  WorkspaceRole,
} from "@dofe-agent/db";
import type {
  ChannelDocumentVersion,
  ChannelRecord,
  DofeAgentState,
  KnowledgePage,
  MessageAttachment,
  WorkspaceMessage,
} from "@dofe-agent/domain/workspace";
import type {
  ChannelDocumentAccessRole,
  ChannelDocumentBlock,
  ChannelDocumentChangeSet,
  ChannelDocumentConflict,
  ChannelDocumentRunStep,
  ChannelDocument,
} from "@dofe-agent/domain";
import {
  listFeishuIntegrationSettingsItems,
} from "@/features/integrations/feishu/feishu-settings-data";
import { listWorkspaceMemberUsersSync } from "@dofe-agent/db";
import type {
  ChannelDocumentChangeSetRecord,
  ChannelDocumentConflictRecord,
  ChannelDocumentPresenceRecord,
  ChannelDocumentRecord,
  ChannelDocumentRunRecord,
  ChannelFeishuSummaryRecord,
  ChannelFileRecord,
  ChannelListItem,
  ChannelDocumentSyncEventRecord,
  KnowledgeDocumentPageRecord,
} from "./data-types";

export const listWorkspaceMemberUsersCached = cache((workspaceId: string) => listWorkspaceMemberUsersSync(workspaceId));

export function isDirectChannelRecord(channel: Pick<ChannelRecord, "kind">): boolean {
  return channel.kind === "direct";
}

export function normalizeChannelScope(channelNames?: string[]): Set<string> | null {
  if (!channelNames) {
    return null;
  }
  const normalized = channelNames.map((name) => name.trim()).filter(Boolean);
  return new Set(normalized);
}

export function resolveDirectChannelForContact(
  state: DofeAgentState,
  currentUserDisplayName: string | undefined,
  employeeName: string,
  workspaceId?: string,
  currentUserId?: string,
  currentMembershipRole?: WorkspaceRole,
): ChannelRecord | null {
  const candidates = state.channels.filter(
    (channel) =>
      isDirectChannelRecord(channel) &&
      channel.employeeNames.some((name) => sameText(name, employeeName)),
  );
  if (candidates.length === 0) {
    return null;
  }

  if (workspaceId && currentUserId) {
    return (
      candidates.find((channel) =>
        canReadChannelForActorSync({
          workspaceId,
          channelName: channel.name,
          actor: {
            userId: currentUserId,
            displayName: currentUserDisplayName,
            role: currentMembershipRole,
          },
        }),
      ) ?? null
    );
  }

  if (currentUserDisplayName?.trim()) {
    return (
      candidates.find((channel) =>
        (channel.humanMemberNames ?? []).some((name) => sameText(name, currentUserDisplayName)),
      ) ?? null
    );
  }

  return candidates[0] ?? null;
}

function resolveChannelMemberCount(channel: Pick<ChannelRecord, "humanMembers" | "employeeNames">): number {
  const humanCount = Array.isArray((channel as { humanMemberNames?: string[] }).humanMemberNames)
    ? ((channel as { humanMemberNames?: string[] }).humanMemberNames?.length ?? channel.humanMembers)
    : channel.humanMembers;
  return Math.max(0, humanCount) + channel.employeeNames.length;
}

export function buildChannelListItem(
  channel: ChannelRecord,
  state: DofeAgentState,
): ChannelListItem {
  if (isDirectChannelRecord(channel)) {
    const directEmployee = state.activeEmployees.find((employee) =>
      channel.employeeNames.some((name) => sameText(name, employee.name)),
    );
    const humanDirectNames = directEmployee ? [] : resolveChannelHumanMemberNames(state, channel);
    const humanDirectDisplayName = humanDirectNames.length > 0 ? humanDirectNames.join(" / ") : channel.name;
    return {
      id: channel.name,
      name: channel.name,
      memberLabel: `${resolveChannelMemberCount(channel)} humans / ${channel.employeeNames.length} agents`,
      humanMemberNames: resolveChannelHumanMemberNames(state, channel),
      employeeNames: [...channel.employeeNames],
      kind: "direct",
      directParticipantKind: directEmployee ? "agent" : "human",
      displayName: directEmployee?.remarkName?.trim() || directEmployee?.name || humanDirectDisplayName,
      displaySubtitle: directEmployee?.name || "Human direct",
      avatarLabel: directEmployee ? "✦" : humanDirectDisplayName.slice(0, 1).toUpperCase(),
      memberCount: resolveChannelMemberCount(channel),
      canManage: false,
    };
  }

  return {
    id: channel.name,
    name: channel.name,
    memberLabel: `${resolveChannelMemberCount(channel)} humans / ${channel.employeeNames.length} agents`,
    humanMemberNames: resolveChannelHumanMemberNames(state, channel),
    employeeNames: [...channel.employeeNames],
    kind: "group",
    displayName: channel.name,
    avatarLabel: "#",
    memberCount: resolveChannelMemberCount(channel),
    canManage: true,
  };
}

interface MentionUnreadViewer {
  userId?: string;
  displayName?: string;
  ownedAgentNames: Set<string>;
}

export function buildMentionUnreadViewer(
  state: DofeAgentState,
  currentUserDisplayName: string | undefined,
  currentUserId: string | undefined,
): MentionUnreadViewer {
  return {
    userId: currentUserId,
    displayName: currentUserDisplayName?.trim() || undefined,
    ownedAgentNames: new Set(
      currentUserId
        ? (state.activeEmployees ?? [])
            .filter((employee) => employee.ownerUserId === currentUserId)
            .map((employee) => employee.name)
        : [],
    ),
  };
}

export function hasUnreadMentionForViewer(messagesNewestFirst: WorkspaceMessage[], viewer: MentionUnreadViewer): boolean {
  if (!viewer.displayName && viewer.ownedAgentNames.size === 0) {
    return false;
  }

  for (const message of messagesNewestFirst) {
    if (viewer.displayName && sameText(message.speaker, viewer.displayName)) {
      return false;
    }

    const mentionsViewer = message.mentions?.some((mention) => isMentionForViewer(mention, viewer)) ?? false;
    if (mentionsViewer && !isMessageAcknowledgedByViewer(message, viewer)) {
      return true;
    }
  }

  return false;
}

function isMentionForViewer(
  mention: NonNullable<WorkspaceMessage["mentions"]>[number],
  viewer: MentionUnreadViewer,
): boolean {
  if (mention.mentionType === "human") {
    return Boolean(
      viewer.displayName
        && (
          sameText(mention.humanId, viewer.displayName)
          || sameText(mention.label, viewer.displayName)
          || sameText(mention.token, viewer.displayName)
        ),
    );
  }

  return Array.from(viewer.ownedAgentNames).some((agentName) =>
    sameText(mention.agentId, agentName) || sameText(mention.label, agentName),
  );
}

function isMessageAcknowledgedByViewer(message: WorkspaceMessage, viewer: MentionUnreadViewer): boolean {
  return message.acknowledgements?.some((acknowledgement) => {
    if (viewer.userId && acknowledgement.userId === viewer.userId) {
      return true;
    }
    if (viewer.displayName && sameText(acknowledgement.label, viewer.displayName)) {
      return true;
    }
    return Array.from(viewer.ownedAgentNames).some((agentName) => sameText(acknowledgement.label, agentName));
  }) ?? false;
}

export function buildChannelWorkspaceArtifacts(
  state: DofeAgentState,
  queuedTasks: ReturnType<typeof listQueuedTasksSync>,
  currentUserDisplayName: string | undefined,
  visibleChannelNames: Set<string>,
  workspaceId: string,
  currentUserId?: string,
  currentMembershipRole?: WorkspaceRole,
): {
  documents: ChannelDocumentRecord[];
  documentRuns: ChannelDocumentRunRecord[];
  documentConflicts: ChannelDocumentConflictRecord[];
  channelFiles: ChannelFileRecord[];
} {
  if (visibleChannelNames.size === 0) {
    return {
      documents: [],
      documentRuns: [],
      documentConflicts: [],
      channelFiles: [],
    };
  }

  const workspaceMemberUsers = listWorkspaceMemberUsersCached(workspaceId);
  const documentById = new Map((state.channelDocuments ?? []).map((document) => [document.id, document]));
  const documentVersionsById = new Map((state.channelDocumentVersions ?? []).map((version) => [version.id, version]));
  const documentVersionsByDocumentId = new Map<string, ChannelDocumentVersion[]>();
  for (const version of state.channelDocumentVersions ?? []) {
    const versions = documentVersionsByDocumentId.get(version.documentId) ?? [];
    versions.push(version);
    documentVersionsByDocumentId.set(version.documentId, versions);
  }
  for (const [documentId, versions] of documentVersionsByDocumentId) {
    documentVersionsByDocumentId.set(
      documentId,
      versions.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()),
    );
  }
  const documentAccessesByDocumentId = new Map<string, NonNullable<DofeAgentState["channelDocumentAccesses"]>>();
  for (const access of state.channelDocumentAccesses ?? []) {
    const accesses = documentAccessesByDocumentId.get(access.documentId) ?? [];
    accesses.push(access);
    documentAccessesByDocumentId.set(access.documentId, accesses);
  }
  const documentBlocksByDocumentId = new Map<string, ChannelDocumentBlock[]>();
  for (const block of state.channelDocumentBlocks ?? []) {
    const blocks = documentBlocksByDocumentId.get(block.documentId) ?? [];
    blocks.push(block);
    documentBlocksByDocumentId.set(block.documentId, blocks);
  }
  for (const [documentId, blocks] of documentBlocksByDocumentId) {
    documentBlocksByDocumentId.set(documentId, blocks.sort((left, right) => left.order - right.order));
  }
  const messageIndex = new Map((state.messages ?? []).map((message) => [message.id, message]));
  const queuedTaskIndex = new Map(queuedTasks.map((task) => [task.id, task]));
  const rawChangeSetIndex = new Map((state.channelDocumentChangeSets ?? []).map((changeSet) => [changeSet.id, changeSet]));
  const runStepByQueuedTaskId = new Map(
    (state.channelDocumentRunSteps ?? [])
      .filter((step) => typeof step.queuedTaskId === "string" && step.queuedTaskId.length > 0)
      .map((step) => [step.queuedTaskId!, step]),
  );
  const runStepByDocumentVersionId = new Map(
    (state.channelDocumentRunSteps ?? [])
      .filter((step) => typeof step.documentVersionId === "string" && step.documentVersionId.length > 0)
      .map((step) => [step.documentVersionId!, step]),
  );
  const channelDocumentChangeSets = (state.channelDocumentChangeSets ?? []).map((changeSet) =>
    buildChannelDocumentChangeSetRecord(changeSet, {
      messageIndex,
      queuedTaskIndex,
      runStepByQueuedTaskId,
      runStepByDocumentVersionId,
    }),
  );
  const changeSetIndex = new Map(channelDocumentChangeSets.map((changeSet) => [changeSet.id, changeSet]));
  const changeSetsByDocumentId = new Map<string, ChannelDocumentChangeSetRecord[]>();
  for (const changeSet of channelDocumentChangeSets) {
    const changeSets = changeSetsByDocumentId.get(changeSet.documentId) ?? [];
    changeSets.push(changeSet);
    changeSetsByDocumentId.set(changeSet.documentId, changeSets);
  }
  const runStepsByRunId = new Map<string, ChannelDocumentRunStep[]>();
  for (const step of state.channelDocumentRunSteps ?? []) {
    const steps = runStepsByRunId.get(step.runId) ?? [];
    steps.push(step);
    runStepsByRunId.set(step.runId, steps);
  }
  for (const [runId, steps] of runStepsByRunId) {
    runStepsByRunId.set(
      runId,
      steps.sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()),
    );
  }
  const activePresencesByDocumentId = new Map<string, ChannelDocumentPresenceRecord[]>();
  const now = Date.now();
  for (const presence of state.channelDocumentPresences ?? []) {
    const updatedAt = new Date(presence.updatedAt).getTime();
    if (!Number.isFinite(updatedAt) || now - updatedAt > CHANNEL_DOCUMENT_PRESENCE_TTL_MS) {
      continue;
    }
    const record: ChannelDocumentPresenceRecord = {
      actorId: presence.actorId,
      actorType: presence.actorType,
      status: presence.status,
      updatedAt: presence.updatedAt,
      isCurrentUser:
        typeof currentUserDisplayName === "string" && currentUserDisplayName.length > 0
          ? currentUserDisplayName.localeCompare(presence.actorId, "zh-CN", { sensitivity: "base" }) === 0
          : false,
    };
    const list = activePresencesByDocumentId.get(presence.documentId) ?? [];
    list.push(record);
    activePresencesByDocumentId.set(presence.documentId, list);
  }
  for (const [documentId, presences] of activePresencesByDocumentId) {
    activePresencesByDocumentId.set(
      documentId,
      presences.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()),
    );
  }
  const openConflictsByDocumentId = new Map<string, ChannelDocumentConflict[]>();
  for (const conflict of state.channelDocumentConflicts ?? []) {
    if (conflict.status !== "open") {
      continue;
    }
    const conflicts = openConflictsByDocumentId.get(conflict.documentId) ?? [];
    conflicts.push(conflict);
    openConflictsByDocumentId.set(conflict.documentId, conflicts);
  }
  const collaboratorCandidatePool = [
    ...workspaceMemberUsers.map((member) => ({
      actorId: member.displayName,
      actorType: "human" as const,
      label: member.displayName,
      subtitle: member.primaryEmail ?? formatWorkspaceRoleLabel(member.role),
    })),
    ...state.activeEmployees.map((employee) => ({
      actorId: employee.name,
      actorType: "agent" as const,
      label: employee.remarkName?.trim() || employee.name,
      subtitle: employee.role,
    })),
  ].sort((left, right) => left.label.localeCompare(right.label, "zh-CN", { sensitivity: "base" }));
  const attachmentReferenceIndex = buildAttachmentReferenceIndex(state);

  const documents = (state.channelDocuments ?? [])
    .filter((document) => visibleChannelNames.has(document.channelName))
    .flatMap((document) => {
      const versions = documentVersionsByDocumentId.get(document.id) ?? [];
      const currentVersion = documentVersionsById.get(document.currentVersionId) ?? versions[0];
      const lastBackgroundSync = currentVersion
        ? buildChannelDocumentSyncEventRecord(currentVersion, {
            messageIndex,
            queuedTaskIndex,
            runStepByDocumentVersionId,
          })
        : undefined;
      const collaborators = (documentAccessesByDocumentId.get(document.id) ?? [])
        .map((access) => ({
          actorId: access.actorId,
          actorType: access.actorType,
          role: access.role,
          isCurrentUser:
            typeof currentUserDisplayName === "string" && currentUserDisplayName.length > 0
              ? currentUserDisplayName.localeCompare(access.actorId, "zh-CN", { sensitivity: "base" }) === 0
              : false,
        }))
        .sort((left, right) => {
          const rank = (role: ChannelDocumentAccessRole) =>
            role === "owner" ? 0 : role === "forwarder" ? 1 : role === "editor" ? 2 : 3;
          const diff = rank(left.role) - rank(right.role);
          if (diff !== 0) {
            return diff;
          }
          return left.actorId.localeCompare(right.actorId, "zh-CN", { sensitivity: "base" });
        });
      const currentUserAccess = collaborators.find((access) => access.isCurrentUser);
      if (typeof currentUserDisplayName === "string" && currentUserDisplayName.length > 0 && !currentUserAccess) {
        return [];
      }
      const currentUserRole = currentUserAccess?.role ?? "viewer";
      const collaboratorKeys = new Set(
        collaborators.map((access) => `${access.actorType}:${access.actorId.toLocaleLowerCase("zh-CN")}`),
      );
      const availableCollaborators = collaboratorCandidatePool.filter(
        (candidate) => !collaboratorKeys.has(`${candidate.actorType}:${candidate.actorId.toLocaleLowerCase("zh-CN")}`),
      );

      return [{
        id: document.id,
        channelName: document.channelName,
        title: document.title,
        slug: document.slug,
        kind: document.kind,
        storageMode: document.storageMode ?? "native",
        currentVersionId: document.currentVersionId,
        summary: document.summary,
        status: document.status,
        updatedAt: document.updatedAt,
        updatedBy: document.updatedBy,
        lastEditorType: document.lastEditorType,
        contentMarkdown: currentVersion?.contentMarkdown ?? "",
        versionCount: versions.length,
        conflictCount: openConflictsByDocumentId.get(document.id)?.length ?? 0,
        versions: versions.map((version) => ({
          id: version.id,
          contentMarkdown: version.contentMarkdown,
          summary: version.summary,
          createdAt: version.createdAt,
          createdBy: version.createdBy,
          createdByType: version.createdByType,
          triggerType: version.triggerType,
          sourceMessageId: version.sourceMessageId,
          sourceAttachmentId: version.sourceAttachmentId,
          sourceAttachmentStoredPath: version.sourceAttachmentStoredPath,
        })),
        changeSets: changeSetsByDocumentId.get(document.id) ?? [],
        activePresences: activePresencesByDocumentId.get(document.id) ?? [],
        currentUserRole,
        collaborators,
        availableCollaborators,
        lastBackgroundSync,
      } satisfies ChannelDocumentRecord];
    });
  const accessibleDocumentIds = new Set(documents.map((document) => document.id));

  const documentRuns = (state.channelDocumentRuns ?? [])
    .filter((run) => visibleChannelNames.has(run.channelName))
    .map((run) => ({
      id: run.id,
      channelName: run.channelName,
      sourceMessageId: run.sourceMessageId,
      sourceSummary: run.sourceSummary,
      mode: run.mode,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      steps: (runStepsByRunId.get(run.id) ?? [])
        .filter((step) => !step.documentId || accessibleDocumentIds.has(step.documentId))
        .map((step) => ({
          id: step.id,
          agentId: step.agentId,
          agentLabel: step.agentLabel,
          instruction: step.instruction,
          status: step.status,
          handoffKind: step.handoffKind,
          documentId: step.documentId,
          documentVersionId: step.documentVersionId,
          lastError: step.lastError,
          lastWarning: step.lastWarning,
        })),
    }) satisfies ChannelDocumentRunRecord);

  const documentConflicts = (state.channelDocumentConflicts ?? [])
    .filter((conflict) => {
      const document = documentById.get(conflict.documentId);
      return Boolean(document && visibleChannelNames.has(document.channelName) && accessibleDocumentIds.has(document.id));
    })
    .map((conflict) => {
      const document = documentById.get(conflict.documentId);
      const currentVersion =
        document ? documentVersionsById.get(document.currentVersionId) : undefined;
      const currentBlocks = documentBlocksByDocumentId.get(conflict.documentId) ?? [];
      return {
        id: conflict.id,
        documentId: conflict.documentId,
        documentTitle: document?.title ?? conflict.documentId,
        blockId: conflict.blockId,
        status: conflict.status,
        createdAt: conflict.createdAt,
        leftChangeSet: changeSetIndex.get(conflict.leftChangeSetId),
        rightChangeSet: changeSetIndex.get(conflict.rightChangeSetId),
        mergePreview: buildChannelDocumentConflictMergePreview({
          conflict,
          document,
          currentVersion,
          currentBlocks,
          rightChangeSet: rawChangeSetIndex.get(conflict.rightChangeSetId),
        }),
      } satisfies ChannelDocumentConflictRecord;
    });

  const channelFiles: ChannelFileRecord[] = [];
  const seenChannelFileIds = new Set<string>();
  for (const message of state.messages ?? []) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.deletedAt) {
        continue;
      }
      const channelName = message.channel ?? "";
      if (
        channelName.trim().length === 0 ||
        !visibleChannelNames.has(channelName) ||
        seenChannelFileIds.has(attachment.id)
      ) {
        continue;
      }
      seenChannelFileIds.add(attachment.id);
      const mediaType = resolveAttachmentMediaType(attachment.fileName, attachment.mediaType);
      const deleteMetadata = buildChannelFileDeleteMetadata({
        state,
        message,
        attachment,
        attachmentReferenceIndex,
        currentUserDisplayName,
        currentUserId,
        currentMembershipRole,
      });
      channelFiles.push({
        id: attachment.id,
        channelName,
        fileName: attachment.fileName,
        sourceMessageId: message.id,
        sourceSpeaker: message.speaker,
        sourceTime: message.time,
        uploaderUserId: message.role === "human" ? message.speakerUserId : undefined,
        uploaderDisplayName: message.role === "human" ? message.speaker : undefined,
        previewText: mediaType === "text/markdown" ? readMarkdownAttachmentPreviewText(attachment) : mediaType,
        mediaType,
        sizeBytes: attachment.sizeBytes,
        kind: inferAttachmentKind(mediaType),
        isMarkdown: mediaType === "text/markdown",
        canDelete: deleteMetadata.canDelete,
        deleteBlockedReason: deleteMetadata.deleteBlockedReason,
        retainedBecauseReferenced: deleteMetadata.retainedBecauseReferenced,
      });
    }
  }

  return {
    documents,
    documentRuns,
    documentConflicts,
    channelFiles,
  };
}

function buildChannelFileDeleteMetadata(input: {
  state: DofeAgentState;
  message: WorkspaceMessage;
  attachment: MessageAttachment;
  attachmentReferenceIndex?: AttachmentReferenceIndex;
  currentUserDisplayName?: string;
  currentUserId?: string;
  currentMembershipRole?: WorkspaceRole;
}): Pick<ChannelFileRecord, "canDelete" | "deleteBlockedReason" | "retainedBecauseReferenced"> {
  const retainedBecauseReferenced = isAttachmentReferencedByKnowledgeOrDocument(
    input.state,
    input.attachment,
    input.attachmentReferenceIndex,
  );
  if (!input.currentUserId) {
    return {
      canDelete: false,
      deleteBlockedReason: "Sign in to delete this file.",
      retainedBecauseReferenced,
    };
  }
  if (isWorkspaceManagerRole(input.currentMembershipRole)) {
    return { canDelete: true, retainedBecauseReferenced };
  }
  if (input.message.role !== "human") {
    return {
      canDelete: false,
      deleteBlockedReason: "Only workspace admins can delete agent output files.",
      retainedBecauseReferenced,
    };
  }
  if (input.message.speakerUserId) {
    if (input.message.speakerUserId === input.currentUserId) {
      return { canDelete: true, retainedBecauseReferenced };
    }
    return {
      canDelete: false,
      deleteBlockedReason: "Only the uploader or a workspace admin can delete this file.",
      retainedBecauseReferenced,
    };
  }
  if (input.currentUserDisplayName?.trim() && sameText(input.message.speaker, input.currentUserDisplayName)) {
    return { canDelete: true, retainedBecauseReferenced };
  }
  return {
    canDelete: false,
    deleteBlockedReason: "Only the uploader or a workspace admin can delete this file.",
    retainedBecauseReferenced,
  };
}

interface AttachmentReferenceIndex {
  ids: Set<string>;
  storedPaths: Set<string>;
}

function buildAttachmentReferenceIndex(state: DofeAgentState): AttachmentReferenceIndex {
  const ids = new Set<string>();
  const storedPaths = new Set<string>();

  for (const page of state.knowledgePages ?? []) {
    if (page.sourceAttachmentId) {
      ids.add(page.sourceAttachmentId);
    }
    if (page.sourceAttachmentStoredPath) {
      storedPaths.add(page.sourceAttachmentStoredPath);
    }
  }

  for (const version of state.channelDocumentVersions ?? []) {
    if (version.sourceAttachmentId) {
      ids.add(version.sourceAttachmentId);
    }
    if (version.sourceAttachmentStoredPath) {
      storedPaths.add(version.sourceAttachmentStoredPath);
    }
  }

  return { ids, storedPaths };
}

function isAttachmentReferencedByKnowledgeOrDocument(
  state: DofeAgentState,
  attachment: MessageAttachment,
  referenceIndex = buildAttachmentReferenceIndex(state),
): boolean {
  return referenceIndex.ids.has(attachment.id) || referenceIndex.storedPaths.has(attachment.storedPath);
}

export function getVisibleWorkspaceChannelNames(
  state: DofeAgentState,
  currentUserDisplayName?: string,
): Set<string> {
  if (!currentUserDisplayName?.trim()) {
    return new Set();
  }

  return new Set(
    state.channels
      .filter((channel) =>
        resolveChannelHumanMemberNames(state, channel).some((memberName) => sameText(memberName, currentUserDisplayName)),
      )
    .map((channel) => channel.name),
  );
}

export function buildKnowledgeDocumentPageRecords(
  documents: ChannelDocumentRecord[],
  channelFiles: ChannelFileRecord[],
  knowledgePages: KnowledgePage[],
): KnowledgeDocumentPageRecord[] {
  const linkIndex = new Map<string, KnowledgeDocumentPageRecord["linkedKnowledgePages"]>();
  const linkedChannelDocumentIndex = new Map<string, KnowledgeDocumentPageRecord["linkedChannelDocuments"]>();

  for (const page of knowledgePages) {
    const link = { id: page.id, title: page.title };
    if (page.sourceAttachmentId) {
      const key = `attachment:${page.sourceAttachmentId}`;
      const existing = linkIndex.get(key) ?? [];
      existing.push(link);
      linkIndex.set(key, existing);
    }
    if (page.sourceChannelDocumentId) {
      const key = `channelDocument:${page.sourceChannelDocumentId}`;
      const existing = linkIndex.get(key) ?? [];
      existing.push(link);
      linkIndex.set(key, existing);
    }
  }

  for (const document of documents) {
    const attachmentIds = new Set(
      document.versions
        .map((version) => version.sourceAttachmentId)
        .filter((attachmentId): attachmentId is string => typeof attachmentId === "string" && attachmentId.length > 0),
    );

    for (const attachmentId of attachmentIds) {
      const key = `attachment:${attachmentId}`;
      const existing = linkedChannelDocumentIndex.get(key) ?? [];
      existing.push({
        id: document.id,
        title: document.title,
        channelName: document.channelName,
      });
      linkedChannelDocumentIndex.set(key, existing);
    }
  }

  const documentPageMap = new Map<string, KnowledgeDocumentPageRecord>();

  for (const document of documents) {
    const fileName = `${document.slug || document.title}.md`;
    const previewText = document.contentMarkdown.trim() || document.summary.trim();
    const sourceAttachmentId = document.versions.find((version) => version.sourceAttachmentId)?.sourceAttachmentId;
    documentPageMap.set(`channelDocument:${document.id}`, {
      id: `channelDocument:${document.id}`,
      sourceType: "channelDocument",
      sourceId: document.id,
      title: document.title,
      summary: document.summary || "Shared Markdown document",
      previewText,
      fileName,
      mediaType: "text/markdown",
      sizeBytes: Buffer.byteLength(document.contentMarkdown, "utf8"),
      kind: "file",
      isMarkdown: true,
      channelName: document.channelName,
      sourceMessageId: document.versions[0]?.sourceMessageId,
      sourceSpeaker: document.updatedBy,
      sourceTime: document.updatedAt,
      updatedAt: document.updatedAt,
      updatedBy: document.updatedBy,
      status: document.status,
      sourceAttachmentId,
      linkedChannelDocuments: [],
      linkedKnowledgePages: linkIndex.get(`channelDocument:${document.id}`) ?? [],
    });
  }

  for (const file of channelFiles) {
    documentPageMap.set(`attachment:${file.id}`, {
      id: `attachment:${file.id}`,
      sourceType: "attachment",
      sourceId: file.id,
      title: file.fileName,
      summary: [file.channelName, file.sourceSpeaker, file.mediaType].filter(Boolean).join(" · ") || file.fileName,
      previewText: file.previewText ?? file.mediaType,
      fileName: file.fileName,
      mediaType: file.mediaType,
      sizeBytes: file.sizeBytes,
      kind: file.kind,
      isMarkdown: file.isMarkdown,
      channelName: file.channelName,
      sourceMessageId: file.sourceMessageId,
      sourceSpeaker: file.sourceSpeaker,
      sourceTime: file.sourceTime,
      updatedAt: file.sourceTime ?? "",
      updatedBy: file.sourceSpeaker ?? "",
      status: "shared",
      linkedChannelDocuments: linkedChannelDocumentIndex.get(`attachment:${file.id}`) ?? [],
      linkedKnowledgePages: linkIndex.get(`attachment:${file.id}`) ?? [],
    });
  }

  for (const page of knowledgePages) {
    if (!page.sourceAttachmentId || !page.sourceAttachmentStoredPath) {
      continue;
    }

    const key = `attachment:${page.sourceAttachmentId}`;
    if (documentPageMap.has(key)) {
      continue;
    }

    documentPageMap.set(key, buildSyntheticAttachmentRecord({
      attachmentId: page.sourceAttachmentId,
      storedPath: page.sourceAttachmentStoredPath,
      contentMarkdown: page.contentMarkdown,
      updatedAt: page.updatedAt,
      updatedBy: page.createdBy,
      linkedKnowledgePages: linkIndex.get(key) ?? [],
      linkedChannelDocuments: linkedChannelDocumentIndex.get(key) ?? [],
    }));
  }

  for (const document of documents) {
    for (const version of document.versions) {
      if (!version.sourceAttachmentId || !version.sourceAttachmentStoredPath) {
        continue;
      }

      const key = `attachment:${version.sourceAttachmentId}`;
      const existing = documentPageMap.get(key);
      if (existing) {
        if (!existing.channelName) {
          existing.channelName = document.channelName;
        }
        if (!existing.sourceTime) {
          existing.sourceTime = version.createdAt;
        }
        if (!existing.updatedAt) {
          existing.updatedAt = version.createdAt;
        }
        if (!existing.updatedBy) {
          existing.updatedBy = version.createdBy;
        }
        existing.linkedChannelDocuments = dedupeLinkedChannelDocuments([
          ...existing.linkedChannelDocuments,
          ...(linkedChannelDocumentIndex.get(key) ?? []),
        ]);
        continue;
      }

      documentPageMap.set(key, buildSyntheticAttachmentRecord({
        attachmentId: version.sourceAttachmentId,
        storedPath: version.sourceAttachmentStoredPath,
        contentMarkdown: version.contentMarkdown,
        channelName: document.channelName,
        updatedAt: version.createdAt,
        updatedBy: version.createdBy,
        linkedKnowledgePages: linkIndex.get(key) ?? [],
        linkedChannelDocuments: linkedChannelDocumentIndex.get(key) ?? [],
      }));
    }
  }

  return [...documentPageMap.values()].sort((left, right) => {
    const timeDiff = new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    if (Number.isFinite(timeDiff) && timeDiff !== 0) {
      return timeDiff;
    }
    return left.title.localeCompare(right.title, "zh-CN", { sensitivity: "base" });
  });
}

function buildSyntheticAttachmentRecord(input: {
  attachmentId: string;
  storedPath: string;
  contentMarkdown: string;
  channelName?: string;
  updatedAt: string;
  updatedBy: string;
  linkedKnowledgePages: KnowledgeDocumentPageRecord["linkedKnowledgePages"];
  linkedChannelDocuments: KnowledgeDocumentPageRecord["linkedChannelDocuments"];
}): KnowledgeDocumentPageRecord {
  const fileName = deriveAttachmentFileName(input.attachmentId, input.storedPath);
  const mediaType = resolveAttachmentMediaType(fileName);
  const sizeBytes = Buffer.byteLength(input.contentMarkdown, "utf8");

  return {
    id: `attachment:${input.attachmentId}`,
    sourceType: "attachment",
    sourceId: input.attachmentId,
    title: fileName,
    summary: input.channelName ? `Preserved attachment · #${input.channelName}` : "Preserved attachment",
    previewText: mediaType === "text/markdown" ? input.contentMarkdown.trim() : mediaType,
    fileName,
    mediaType,
    sizeBytes,
    kind: inferAttachmentKind(mediaType),
    isMarkdown: mediaType === "text/markdown",
    channelName: input.channelName,
    updatedAt: input.updatedAt,
    updatedBy: input.updatedBy,
    status: "shared",
    linkedChannelDocuments: dedupeLinkedChannelDocuments(input.linkedChannelDocuments),
    linkedKnowledgePages: input.linkedKnowledgePages,
  };
}

function deriveAttachmentFileName(attachmentId: string, storedPath: string): string {
  const storedName = basename(storedPath.replace(/\\/g, "/"));
  const prefix = `${attachmentId}-`;
  return storedName.startsWith(prefix) ? storedName.slice(prefix.length) : storedName;
}

function readMarkdownAttachmentPreviewText(attachment: MessageAttachment): string {
  try {
    return Buffer.from(readWorkspaceAttachmentBytesSync(attachment)).toString("utf8").trim();
  } catch {
    return "";
  }
}

function dedupeLinkedChannelDocuments(
  documents: KnowledgeDocumentPageRecord["linkedChannelDocuments"],
): KnowledgeDocumentPageRecord["linkedChannelDocuments"] {
  return documents.filter(
    (document, index, all) =>
      all.findIndex((candidate) => candidate.id === document.id) === index,
  );
}

export function buildFeishuChannelSummaryByChannelName(input: {
  workspaceId: string;
  canView: boolean;
  viewer?: {
    role: WorkspaceRole;
    userId: string;
  };
}): Map<string, ChannelFeishuSummaryRecord> {
  if (!input.canView) {
    return new Map();
  }

  const summaries = new Map<string, ChannelFeishuSummaryRecord>();
  const connectedBotKeys = new Set<string>();
  const resourceKeys = new Set<string>();
  const integrations = listFeishuIntegrationSettingsItems({
    workspaceId: input.workspaceId,
    viewer: input.viewer,
  });

  const ensureSummary = (channelName: string): ChannelFeishuSummaryRecord => {
    const current = summaries.get(channelName);
    if (current) {
      return current;
    }
    const next: ChannelFeishuSummaryRecord = {
      bindingCount: 0,
      connectedAgentBots: [],
      resourceBindings: [],
    };
    summaries.set(channelName, next);
    return next;
  };

  for (const integration of integrations) {
    for (const binding of integration.channelBindings) {
      if (binding.status === "archived") {
        continue;
      }
      const summary = ensureSummary(binding.channelName);
      summary.bindingCount += 1;
      if (!summary.externalChatReference || binding.status === "active") {
        summary.externalChatReference = binding.externalChatReference;
        summary.externalChatName = binding.externalChatName;
        summary.externalChatType = binding.externalChatType;
        summary.provisionSource = binding.provisionSource;
        summary.reviewStatus = binding.reviewStatus;
      }
      if (integration.agentId && binding.status === "active") {
        const key = `${binding.channelName}:${integration.id}:${integration.agentId}`;
        if (!connectedBotKeys.has(key)) {
          connectedBotKeys.add(key);
          summary.connectedAgentBots.push({
            integrationId: integration.id,
            displayName: integration.displayName,
            agentId: integration.agentId,
            status: integration.status,
            unboundUserMode: integration.externalGuestPolicy?.unboundUserMode,
            guestPermissionProfile: integration.externalGuestPolicy?.guestPermissionProfile,
          });
        }
      }
    }

    for (const resourceBinding of integration.resourceBindings) {
      if (!resourceBinding.channelName || resourceBinding.status === "archived") {
        continue;
      }
      const key = `${resourceBinding.channelName}:${integration.id}:${resourceBinding.id}`;
      if (resourceKeys.has(key)) {
        continue;
      }
      resourceKeys.add(key);
      const summary = ensureSummary(resourceBinding.channelName);
      summary.resourceBindings.push({
        id: resourceBinding.id,
        integrationId: integration.id,
        integrationDisplayName: integration.displayName,
        providerResourceType: resourceBinding.providerResourceType,
        displayName: resourceBinding.displayName,
        canWrite: resourceBinding.canWrite,
        guestReadable: resourceBinding.guestReadable,
        status: resourceBinding.status,
      });
    }
  }

  return summaries;
}

const CHANNEL_DOCUMENT_PRESENCE_TTL_MS = 90_000;
export const CHANNEL_DOCUMENT_SYNC_EVENT_TTL_MS = 10 * 60_000;
export const TASK_QUEUE_DELAY_THRESHOLD_MS = 10_000;

export function isWorkspaceManagerRole(role: WorkspaceRole | undefined): boolean {
  return role === "owner" || role === "admin";
}
export function formatWorkspaceRoleLabel(role: WorkspaceRole): string {
  if (role === "owner") {
    return "Owner";
  }
  if (role === "admin") {
    return "Admin";
  }
  return "Member";
}
export function safeReadTaskTitle(inputJson: string): string | undefined {
  try {
    const parsed = JSON.parse(inputJson) as Record<string, unknown>;
    return typeof parsed.title === "string" ? parsed.title : undefined;
  } catch {
    return undefined;
  }
}

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

export function sameText(left: string, right: string): boolean {
  return left.localeCompare(right, "zh-CN", { sensitivity: "base" }) === 0;
}
