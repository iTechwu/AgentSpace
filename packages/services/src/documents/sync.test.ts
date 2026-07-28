import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import {
  addChannelDocumentCollaboratorSync,
  completeChannelDocumentRunStepSync,
  clearChannelDocumentPresenceSync,
  createEmployeeSync,
  createChannelDocumentSync,
  createChannelDocumentFromAttachmentSync,
  canViewChannelDocumentSync,
  ensureWorkspaceStateSync,
  initializeOrganizationSync,
  listChannelDocumentBlocksSync,
  listChannelDocumentAccessesSync,
  listChannelMarkdownAttachmentsSync,
  persistWorkspaceAttachmentFromBytesSync,
  readChannelDocumentSync,
  recordChannelDocumentConflictSync,
  removeChannelDocumentCollaboratorSync,
  resetWorkspaceStateSync,
  resolveChannelDocumentConflictSync,
  retryChannelDocumentConflictSync,
  sendChannelHumanMessageSync,
  setAttachmentStorageClientForTests,
  type AttachmentStorageClient,
  updateChannelDocumentAccessRoleSync,
  updateExternalChannelDocumentMetadataSync,
  upsertChannelDocumentPresenceSync,
  updateChannelDocumentSync,
  writeWorkspaceStateSync,
} from "../index.ts";
import { createChannelDocumentRun, markChannelDocumentRunStepQueued } from "./runs.ts";
import { applyChannelDocumentBlockOperations } from "./operations.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-doc-sync-"));
const tosObjects = new Map<string, Uint8Array>();
const testTosStorage: AttachmentStorageClient = {
  async putObject(input) {
    return this.putObjectSync(input);
  },
  putObjectSync(input) {
    const key = `workspaces/${input.workspaceId}/attachments/${input.attachmentId}/${input.fileName}`;
    const bytes = new Uint8Array(input.contentBytes);
    tosObjects.set(key, bytes);
    return {
      provider: "tos",
      bucket: "test-bucket",
      region: "cn-beijing",
      endpoint: "https://tos-cn-beijing.volces.com",
      key,
      storedPath: `tos://test-bucket/${key}`,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  },
  async getObject(input) {
    return this.getObjectSync(input);
  },
  getObjectSync(input) {
    const bytes = tosObjects.get(input.storageKey ?? "");
    if (!bytes) throw new Error(`NoSuchKey: ${input.storageKey ?? ""}`);
    return new Uint8Array(bytes);
  },
  async headObject() {
    return null;
  },
  async deleteObject(input) {
    tosObjects.delete(input.storageKey ?? "");
  },
  deleteObjectSync(input) {
    tosObjects.delete(input.storageKey ?? "");
  },
  async createReadUrl(input) {
    return input.storageKey ? `https://test-bucket.example.com/${input.storageKey}` : null;
  },
};

before(() => {
  process.env.NODE_ENV = "test";
  setAttachmentStorageClientForTests(testTosStorage);
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

test.after(() => {
  setAttachmentStorageClientForTests(undefined);
});

function resetWorkspace() {
  resetWorkspaceStateSync();
  initializeOrganizationSync({
    organizationName: "Northstar Labs",
    ownerName: "techwu",
    ownerRole: "Founder",
    firstChannelName: "tour visit",
  });
  createEmployeeSync({
    name: "Atlas",
    role: "Planner",
    remarkName: "Atlas",
    summary: "Atlas",
    fit: "Atlas",
    origin: "seed",
  });
  createEmployeeSync({
    name: "Nova",
    role: "Operator",
    remarkName: "Nova",
    summary: "Nova",
    fit: "Nova",
    origin: "seed",
  });
  createEmployeeSync({
    name: "Test",
    role: "Document Coordinator",
    remarkName: "Test",
    summary: "Test",
    fit: "Test",
    origin: "seed",
  });
  createEmployeeSync({
    name: "techwu's assistant",
    role: "Assistant",
    remarkName: "techwu's assistant",
    summary: "techwu's assistant",
    fit: "techwu's assistant",
    origin: "seed",
  });
  const state = ensureWorkspaceStateSync();
  const employeeNames = ["Atlas", "Nova", "Test", "techwu's assistant"];
  state.activeEmployees = state.activeEmployees.map((employee) =>
    employeeNames.includes(employee.name)
      ? {
          ...employee,
          channels: ["tour visit"],
        }
      : employee,
  );
  state.channels = state.channels.map((channel) =>
    channel.name === "tour visit"
      ? {
          ...channel,
          employeeNames,
        }
      : channel,
  );
  writeWorkspaceStateSync(state);
}

test("updateChannelDocumentSync saves title and content together", () => {
  resetWorkspace();

  const created = createChannelDocumentSync({
    channelName: "tour visit",
    title: "大阪-濑户内海行程",
    contentMarkdown: "## Day 1\n大阪",
    createdBy: "techwu",
    createdByType: "human",
  });

  const updated = updateChannelDocumentSync({
    documentId: created.document.id,
    title: "大阪-濑户内海春季行程",
    contentMarkdown: "## Day 1\n大阪\n\n## Day 2\n宇治",
    updatedBy: "techwu",
    updatedByType: "human",
    baseVersionId: created.version.id,
    triggerType: "manual",
  });

  assert.equal(updated.document.title, "大阪-濑户内海春季行程");
  assert.match(updated.version.contentMarkdown, /Day 2/);

  const persisted = readChannelDocumentSync(created.document.id);
  assert.equal(persisted.document.title, "大阪-濑户内海春季行程");
  assert.match(persisted.currentVersion.contentMarkdown, /Day 2/);
});

test("legacy channel documents normalize to native markdown documents", () => {
  resetWorkspace();

  const state = ensureWorkspaceStateSync();
  state.channelDocuments.unshift({
    id: "legacy-doc",
    channelName: "tour visit",
    title: "Legacy notes",
    slug: "legacy-notes",
    kind: undefined,
    status: "active",
    currentVersionId: "legacy-version",
    summary: "",
    lastEditorType: "human",
    createdBy: "techwu",
    updatedBy: "techwu",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as typeof state.channelDocuments[number]);
  state.channelDocumentVersions.unshift({
    id: "legacy-version",
    documentId: "legacy-doc",
    contentMarkdown: "# Legacy",
    summary: "",
    createdBy: "techwu",
    createdByType: "human",
    triggerType: "manual",
    createdAt: new Date().toISOString(),
  });
  writeWorkspaceStateSync(state);

  const persisted = readChannelDocumentSync("legacy-doc");

  assert.equal(persisted.document.kind, "markdown");
  assert.equal(persisted.document.storageMode, "native");
  assert.equal(persisted.currentVersion.contentJson, undefined);
});

test("createChannelDocumentSync preserves native sheet contract fields without markdown blocks", () => {
  resetWorkspace();

  const sheetContent = {
    columns: [
      { id: "item", name: "Item", type: "text" },
      { id: "owner", name: "Owner", type: "person" },
    ],
    rows: [{ id: "row-1", cells: { item: "Data source audit", owner: "Atlas" } }],
  };
  const created = createChannelDocumentSync({
    channelName: "tour visit",
    title: "数据源审计表",
    kind: "sheet",
    storageMode: "native",
    contentJson: sheetContent,
    summary: "数据源审计表",
    createdBy: "techwu",
    createdByType: "human",
  });

  assert.equal(created.document.kind, "sheet");
  assert.equal(created.document.storageMode, "native");
  assert.deepEqual(created.version.contentJson, sheetContent);
  assert.equal(listChannelDocumentBlocksSync(created.document.id).length, 0);

  const persisted = readChannelDocumentSync(created.document.id);
  assert.equal(persisted.document.kind, "sheet");
  assert.deepEqual(persisted.currentVersion.contentJson, sheetContent);
});

test("createChannelDocumentSync preserves external document binding metadata", () => {
  resetWorkspace();

  const created = createChannelDocumentSync({
    channelName: "tour visit",
    title: "外部项目说明",
    kind: "document",
    storageMode: "external",
    externalProvider: "notion",
    externalFileId: "page-123",
    externalUrl: "https://www.notion.so/page-123",
    externalRevisionId: "revision-1",
    contentJson: { syncedAt: "2026-05-01T00:00:00.000Z" },
    summary: "Notion 项目说明",
    createdBy: "techwu",
    createdByType: "human",
  });

  assert.equal(created.document.kind, "document");
  assert.equal(created.document.storageMode, "external");
  assert.equal(created.document.externalProvider, "notion");
  assert.equal(created.document.externalFileId, "page-123");
  assert.equal(created.document.externalRevisionId, "revision-1");

  const persisted = readChannelDocumentSync(created.document.id);
  assert.equal(persisted.document.externalUrl, "https://www.notion.so/page-123");
  assert.deepEqual(persisted.currentVersion.contentJson, { syncedAt: "2026-05-01T00:00:00.000Z" });
});

test("create and update change sets keep version and source metadata", () => {
  resetWorkspace();

  const created = createChannelDocumentSync({
    channelName: "tour visit",
    title: "日本一周行程方案",
    contentMarkdown: "## Day 1\n大阪",
    createdBy: "Test",
    createdByType: "agent",
    sourceMessageId: "message-create",
    sourceTaskQueueId: "queue-create",
    triggerType: "agent",
  });

  const updated = updateChannelDocumentSync({
    documentId: created.document.id,
    contentMarkdown: "## Day 1\n大阪\n\n## Day 2\n宇治",
    updatedBy: "techwu's assistant",
    updatedByType: "agent",
    baseVersionId: created.version.id,
    sourceMessageId: "message-update",
    sourceTaskQueueId: "queue-update",
    triggerType: "handoff",
  });

  const persisted = ensureWorkspaceStateSync();
  const [latestChangeSet, createdChangeSet] = persisted.channelDocumentChangeSets.filter(
    (changeSet) => changeSet.documentId === created.document.id,
  );

  assert.equal(latestChangeSet?.documentVersionId, updated.version.id);
  assert.equal(latestChangeSet?.baseVersionId, created.version.id);
  assert.equal(latestChangeSet?.sourceMessageId, "message-update");
  assert.equal(latestChangeSet?.sourceTaskQueueId, "queue-update");
  assert.equal(createdChangeSet?.documentVersionId, created.version.id);
  assert.equal(createdChangeSet?.sourceMessageId, "message-create");
  assert.equal(createdChangeSet?.sourceTaskQueueId, "queue-create");
});

test("updateChannelDocumentSync keeps the original title when a stale save conflicts", () => {
  resetWorkspace();

  const created = createChannelDocumentSync({
    channelName: "tour visit",
    title: "大阪-濑户内海行程",
    contentMarkdown: "## Day 1\n大阪",
    createdBy: "techwu",
    createdByType: "human",
  });

  updateChannelDocumentSync({
    documentId: created.document.id,
    contentMarkdown: "## Day 1\n大阪\n\n## Day 2\n宇治",
    updatedBy: "Atlas",
    updatedByType: "agent",
    baseVersionId: created.version.id,
    triggerType: "agent",
  });

  assert.throws(
    () =>
      updateChannelDocumentSync({
        documentId: created.document.id,
        title: "大阪-濑户内海春季行程",
        contentMarkdown: "## Day 1\n大阪\n\n## Day 2\n奈良",
        updatedBy: "techwu",
        updatedByType: "human",
        baseVersionId: created.version.id,
        triggerType: "manual",
      }),
    /updated by someone else/,
  );

  const persisted = readChannelDocumentSync(created.document.id);
  assert.equal(persisted.document.title, "大阪-濑户内海行程");
  assert.match(persisted.currentVersion.contentMarkdown, /Day 2\n宇治/);
});

test("markdown attachments with octet-stream media type in TOS show up as channel files and can import into documents", () => {
  resetWorkspace();

  const attachment = persistWorkspaceAttachmentFromBytesSync({
    contentBytes: Buffer.from("# TOS itinerary\n\n## Day 1\n大阪\n", "utf8"),
    fileName: "itinerary_detailed.md",
    mediaType: "application/octet-stream",
  });

  sendChannelHumanMessageSync("tour visit", "techwu", "请看附件", [
    {
      ...attachment,
    },
  ]);

  const markdownAttachments = listChannelMarkdownAttachmentsSync("tour visit");
  assert.equal(markdownAttachments.length, 1);
  assert.equal(markdownAttachments[0]?.id, attachment.id);

  const created = createChannelDocumentFromAttachmentSync({
    channelName: "tour visit",
    attachmentId: attachment.id,
    createdBy: "techwu",
    createdByType: "human",
  });

  assert.equal(created.document.title, "itinerary_detailed");
  assert.match(created.version.contentMarkdown, /TOS itinerary/);
  assert.equal(created.version.sourceAttachmentId, attachment.id);
  assert.equal(created.version.sourceAttachmentStoredPath, attachment.storedPath);
});

test("completeChannelDocumentRunStepSync warns when a document step finishes without a new version", () => {
  const originalCwd = process.cwd();
  const repoRoot = mkdtempSync(join(tmpdir(), "dofe-agent-doc-runs-"));

  try {
    writeFileSync(join(repoRoot, "Target.md"), "# test\n");
    mkdirSync(join(repoRoot, "data"), { recursive: true });
    process.chdir(repoRoot);

    resetWorkspaceStateSync();
    initializeOrganizationSync({
      organizationName: "Northstar Labs",
      ownerName: "techwu",
      ownerRole: "Founder",
      firstChannelName: "tour visit",
    });

    const state = ensureWorkspaceStateSync();
    const { steps } = createChannelDocumentRun({
      state,
      channelName: "tour visit",
      sourceMessageId: "message-1",
      sourceSummary: "@Atlas 先整理，再让 @Nova 完善",
      plan: {
        mode: "sequential",
        steps: [
          {
            id: "step-1",
            agentId: "Atlas",
            agentLabel: "Atlas",
            instruction: "先整理文档",
            dependsOnStepIds: [],
            handoffKind: "document",
          },
        ],
        warnings: [],
        unknownMentions: [],
      },
    });
    markChannelDocumentRunStepQueued(state, steps[0]!.id, "queue-1");
    writeWorkspaceStateSync(state);

    completeChannelDocumentRunStepSync({
      queuedTaskId: "queue-1",
    });

    const persisted = ensureWorkspaceStateSync();
    const messages = persisted.messages.filter((message) => message.channel === "tour visit");
    const run = persisted.channelDocumentRuns[0];
    const step = persisted.channelDocumentRunSteps[0];

    assert.equal(messages[0]?.code, "channel_document.run_completed_with_warning_notice");
    assert.equal(messages[0]?.status, "error");
    assert.equal(messages[1]?.code, "channel_document.step_completed_without_update_notice");
    assert.equal(messages[1]?.status, "error");
    assert.equal(run?.status, "completed_with_warning");
    assert.equal(step?.status, "completed_with_warning");
    assert.match(step?.lastWarning ?? "", /No new document version was written/i);
  } finally {
    process.chdir(originalCwd);
  }
});

test("createChannelDocumentFromAttachmentSync rejects markdown attachments from inaccessible channels", () => {
  resetWorkspace();
  const state = ensureWorkspaceStateSync();
  state.humanMembers.push({
    name: "Mina",
    role: "Operator",
  });
  state.channels.push({
    name: "secret-room",
    humanMemberNames: ["Mina"],
    humanMembers: 1,
    employeeNames: [],
  });
  state.messages.push({
    id: "message-secret-attachment",
    channel: "secret-room",
    speaker: "Mina",
    role: "human",
    time: "11:30",
    summary: "Secret markdown attachment",
    status: "completed",
    attachments: [
      {
        id: "att-secret-md",
        fileName: "secret-plan.md",
        mediaType: "text/markdown",
        sizeBytes: 18,
        kind: "file",
        storedPath: "tos://test-bucket/workspaces/default/attachments/att-secret-md/secret-plan.md",
        storageProvider: "tos",
        storageKey: "workspaces/default/attachments/att-secret-md/secret-plan.md",
      },
    ],
  });
  writeWorkspaceStateSync(state);

  assert.throws(
    () => createChannelDocumentFromAttachmentSync({
      channelName: "tour visit",
      attachmentId: "att-secret-md",
      createdBy: "techwu",
      createdByType: "human",
    }),
    /cannot access attachment/,
  );
});

test("resolveChannelDocumentConflictSync marks an open conflict as resolved", () => {
  resetWorkspace();

  const created = createChannelDocumentSync({
    channelName: "tour visit",
    title: "日本一周行程方案",
    contentMarkdown: "## Day 1\n大阪",
    createdBy: "Test",
    createdByType: "agent",
    triggerType: "agent",
  });

  recordChannelDocumentConflictSync({
    documentId: created.document.id,
    actorId: "techwu's assistant",
    actorType: "agent",
    baseVersionId: created.version.id,
    operationsJson: JSON.stringify([{ op: "replace_document", title: created.document.title }]),
    sourceMessageId: "message-conflict",
    sourceTaskQueueId: "queue-conflict",
  });

  const conflictId = ensureWorkspaceStateSync().channelDocumentConflicts[0]?.id;
  assert.ok(conflictId);

  resolveChannelDocumentConflictSync({
    conflictId: conflictId!,
    resolvedBy: "techwu",
    resolvedByType: "human",
  });

  const persisted = ensureWorkspaceStateSync();
  assert.equal(persisted.channelDocumentConflicts[0]?.status, "resolved");
  assert.equal(persisted.messages[0]?.code, "channel_document.conflict_resolved_notice");
});

test("upsertChannelDocumentPresenceSync tracks and clears human presence", () => {
  resetWorkspace();

  const created = createChannelDocumentSync({
    channelName: "tour visit",
    title: "日本一周行程方案",
    contentMarkdown: "## Day 1\n大阪",
    createdBy: "techwu",
    createdByType: "human",
    triggerType: "manual",
  });

  upsertChannelDocumentPresenceSync({
    documentId: created.document.id,
    actorId: "techwu",
    actorType: "human",
    status: "viewing",
  });
  upsertChannelDocumentPresenceSync({
    documentId: created.document.id,
    actorId: "techwu",
    actorType: "human",
    status: "editing",
  });

  let persisted = ensureWorkspaceStateSync();
  assert.equal(persisted.channelDocumentPresences.length, 1);
  assert.equal(persisted.channelDocumentPresences[0]?.status, "editing");

  clearChannelDocumentPresenceSync({
    documentId: created.document.id,
    actorId: "techwu",
    actorType: "human",
  });
  persisted = ensureWorkspaceStateSync();
  assert.equal(persisted.channelDocumentPresences.length, 0);
});

test("retryChannelDocumentConflictSync reapplies a conflicted replace_document update on top of the latest version", () => {
  resetWorkspace();

  const created = createChannelDocumentSync({
    channelName: "tour visit",
    title: "日本一周行程方案",
    contentMarkdown: "## Day 1\n大阪",
    createdBy: "techwu",
    createdByType: "human",
    triggerType: "manual",
  });

  const updated = updateChannelDocumentSync({
    documentId: created.document.id,
    contentMarkdown: "## Day 1\n大阪\n\n## Day 2\n宇治",
    updatedBy: "Atlas",
    updatedByType: "agent",
    baseVersionId: created.version.id,
    triggerType: "agent",
  });

  assert.throws(
    () =>
      updateChannelDocumentSync({
        documentId: created.document.id,
        contentMarkdown: "## Day 1\n大阪\n\n## Day 2\n奈良",
        updatedBy: "Nova",
        updatedByType: "agent",
        baseVersionId: created.version.id,
        triggerType: "handoff",
        sourceMessageId: "message-retry",
        sourceTaskQueueId: "queue-retry",
      }),
    /updated by someone else/,
  );

  const beforeRetry = ensureWorkspaceStateSync();
  const conflictId = beforeRetry.channelDocumentConflicts[0]?.id;
  assert.ok(conflictId);

  const result = retryChannelDocumentConflictSync({
    conflictId: conflictId!,
    retriedBy: "techwu",
    retriedByType: "human",
  });

  assert.match(result.version.contentMarkdown, /奈良/);

  const persisted = ensureWorkspaceStateSync();
  assert.equal(persisted.channelDocumentConflicts[0]?.status, "resolved");
  assert.equal(persisted.messages[0]?.code, "channel_document.conflict_retried_notice");
  assert.equal(persisted.channelDocuments.find((document) => document.id === created.document.id)?.currentVersionId, result.version.id);
  assert.equal(updated.document.id, created.document.id);
});

test("retryChannelDocumentConflictSync reapplies a conflicted block update on top of the latest block revision", () => {
  resetWorkspace();

  const created = createChannelDocumentSync({
    channelName: "tour visit",
    title: "日本一周行程方案",
    contentMarkdown: "## Day 1\n大阪\n\n## Day 2\n宇治",
    createdBy: "techwu",
    createdByType: "human",
    triggerType: "manual",
  });

  const state = ensureWorkspaceStateSync();
  const targetBlock = state.channelDocumentBlocks.find(
    (block) => block.documentId === created.document.id && /Day 2/.test(block.contentMarkdown),
  );
  assert.ok(targetBlock);
  targetBlock!.revision += 1;
  writeWorkspaceStateSync(state);

  const result = applyChannelDocumentBlockOperations({
    state: ensureWorkspaceStateSync(),
    document: ensureWorkspaceStateSync().channelDocuments.find((document) => document.id === created.document.id)!,
    baseVersionId: created.version.id,
    actorId: "Nova",
    actorType: "agent",
    operations: [
      {
        op: "replace_block",
        blockId: targetBlock!.id,
        baseRevision: targetBlock!.revision - 1,
        contentMarkdown: "## Day 2\n奈良",
      },
    ],
    sourceMessageId: "message-block-retry",
    sourceTaskQueueId: "queue-block-retry",
  });
  writeWorkspaceStateSync(result.state);
  assert.equal(result.conflictCount, 1);

  const conflictId = ensureWorkspaceStateSync().channelDocumentConflicts[0]?.id;
  assert.ok(conflictId);

  const retried = retryChannelDocumentConflictSync({
    conflictId: conflictId!,
    retriedBy: "techwu",
    retriedByType: "human",
  });

  assert.match(retried.version.contentMarkdown, /奈良/);
  assert.equal(ensureWorkspaceStateSync().channelDocumentConflicts[0]?.status, "resolved");
  assert.ok(listChannelDocumentBlocksSync(created.document.id).some((block) => /奈良/.test(block.contentMarkdown)));
});

test("channel documents seed owner/editor roles and reject viewer edits", () => {
  resetWorkspace();

  const created = createChannelDocumentSync({
    channelName: "tour visit",
    title: "权限测试文档",
    contentMarkdown: "## Day 1\n大阪",
    createdBy: "techwu",
    createdByType: "human",
    triggerType: "manual",
  });

  const accesses = listChannelDocumentAccessesSync(created.document.id);
  assert.equal(accesses[0]?.role, "owner");
  assert.equal(accesses[0]?.actorId, "techwu");

  assert.throws(
    () =>
      updateChannelDocumentAccessRoleSync({
        documentId: created.document.id,
        actorId: "techwu",
        actorType: "human",
        role: "viewer",
        changedBy: "techwu",
        changedByType: "human",
      }),
    /at least one owner/i,
  );

  writeWorkspaceStateSync({
    ...ensureWorkspaceStateSync(),
    humanMembers: [
      ...ensureWorkspaceStateSync().humanMembers,
      { name: "Nova", role: "Ops" },
    ],
  });
  updateChannelDocumentAccessRoleSync({
    documentId: created.document.id,
    actorId: "Nova",
    actorType: "human",
    role: "viewer",
    changedBy: "techwu",
    changedByType: "human",
  });

  assert.throws(
    () =>
      updateChannelDocumentSync({
        documentId: created.document.id,
        contentMarkdown: "## Day 1\n奈良",
        updatedBy: "Nova",
        updatedByType: "human",
        baseVersionId: created.version.id,
        triggerType: "manual",
      }),
    /does not have permission/i,
  );
});

test("document collaborator add/remove operations update access records and audit messages", () => {
  resetWorkspace();

  const created = createChannelDocumentSync({
    channelName: "tour visit",
    title: "协作者测试文档",
    contentMarkdown: "## Day 1\n大阪",
    createdBy: "techwu",
    createdByType: "human",
    triggerType: "manual",
  });
  createEmployeeSync({
    name: "Beacon",
    role: "Reviewer",
    remarkName: "Beacon",
    summary: "Beacon",
    fit: "Beacon",
    origin: "seed",
  });

  addChannelDocumentCollaboratorSync({
    documentId: created.document.id,
    actorId: "Beacon",
    actorType: "agent",
    role: "viewer",
    addedBy: "techwu",
    addedByType: "human",
  });

  let persisted = ensureWorkspaceStateSync();
  assert.equal(
    persisted.channelDocumentAccesses.some(
      (access) => access.documentId === created.document.id && access.actorId === "Beacon" && access.role === "viewer",
    ),
    true,
  );
  assert.equal(persisted.messages[0]?.code, "channel_document.collaborator_added_notice");

  removeChannelDocumentCollaboratorSync({
    documentId: created.document.id,
    actorId: "Beacon",
    actorType: "agent",
    removedBy: "techwu",
    removedByType: "human",
  });

  persisted = ensureWorkspaceStateSync();
  assert.equal(
    persisted.channelDocumentAccesses.some(
      (access) => access.documentId === created.document.id && access.actorId === "Beacon",
    ),
    false,
  );
  assert.equal(canViewChannelDocumentSync(created.document.id, "Beacon", "agent"), false);
  assert.throws(
    () =>
      upsertChannelDocumentPresenceSync({
        documentId: created.document.id,
        actorId: "Beacon",
        actorType: "agent",
        status: "viewing",
      }),
    /does not have permission to view/i,
  );
  assert.equal(persisted.messages[0]?.code, "channel_document.collaborator_removed_notice");
});

test.after(() => {
  process.chdir(originalCwd);
});
