// 频道文档域视图装配：buildChannelWorkspaceArtifacts 汇总可见频道下的文档、
// 文档运行、开放冲突与频道文件。会读工作区成员（cached）并复用变更集/附件域 helper。
import { inferAttachmentKind, resolveAttachmentMediaType } from "@dofe-agent/services/workspace";
import type {
  listQueuedTasksSync,
} from "@dofe-agent/db";
import type {
  WorkspaceRole,
} from "@dofe-agent/db";
import type {
  ChannelDocumentVersion,
  DofeAgentState,
} from "@dofe-agent/domain/workspace";
import type {
  ChannelDocumentAccessRole,
  ChannelDocumentBlock,
  ChannelDocumentConflict,
  ChannelDocumentRunStep,
} from "@dofe-agent/domain";
import type {
  ChannelDocumentChangeSetRecord,
  ChannelDocumentConflictRecord,
  ChannelDocumentPresenceRecord,
  ChannelDocumentRecord,
  ChannelDocumentRunRecord,
  ChannelFileRecord,
} from "../data-types";
import { formatWorkspaceRoleLabel, listWorkspaceMemberUsersCached } from "./workspace-members";
import {
  buildAttachmentReferenceIndex,
  buildChannelFileDeleteMetadata,
  readMarkdownAttachmentPreviewText,
} from "./channel-files";
import {
  buildChannelDocumentChangeSetRecord,
  buildChannelDocumentConflictMergePreview,
  buildChannelDocumentSyncEventRecord,
} from "./document-changesets";

const CHANNEL_DOCUMENT_PRESENCE_TTL_MS = 90_000;

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
