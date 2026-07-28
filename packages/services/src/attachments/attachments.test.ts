import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";
import { createUserSync, createWorkspaceMembershipSync, DEFAULT_WORKSPACE_ID } from "@dofe-agent/db";
import {
  createChannelDocumentFromAttachmentSync,
  createKnowledgePageFromSharedDocumentSync,
  deleteChannelAttachmentSync,
  deleteChannelSync,
  deleteWorkspaceAttachmentsSync,
  persistWorkspaceAttachmentFromBytesSync,
  persistWorkspaceAttachmentFromFileSync,
  readWorkspaceStateSync,
  resetWorkspaceStateSync,
  setAttachmentStorageClientForTests,
  type AttachmentStorageClient,
  writeWorkspaceStateSync,
} from "../index.ts";

const originalCwd = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), "dofe-agent-attachments-"));
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
    if (!bytes) {
      throw new Error(`NoSuchKey: ${input.storageKey ?? ""}`);
    }
    return new Uint8Array(bytes);
  },
  async headObject(input) {
    const key = input.storageKey ?? "";
    const bytes = tosObjects.get(key);
    return bytes ? {
      provider: "tos",
      bucket: "test-bucket",
      region: "cn-beijing",
      endpoint: "https://tos-cn-beijing.volces.com",
      key,
      storedPath: input.storedPath,
      sizeBytes: bytes.byteLength,
    } : null;
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

function readTosObject(attachment: { storageKey?: string }): string | undefined {
  const bytes = tosObjects.get(attachment.storageKey ?? "");
  return bytes ? Buffer.from(bytes).toString("utf8") : undefined;
}

function hasTosObject(attachment: { storageKey?: string }): boolean {
  return tosObjects.has(attachment.storageKey ?? "");
}

before(() => {
  process.env.NODE_ENV = "test";
  setAttachmentStorageClientForTests(testTosStorage);
  writeFileSync(join(tempRoot, "Target.md"), "# test\n");
  mkdirSync(join(tempRoot, "data"), { recursive: true });
  process.chdir(tempRoot);
});

function createWorkspaceMember(baseName: string, role: "owner" | "admin" | "member"): { id: string; displayName: string } {
  const suffix = Math.random().toString(36).slice(2, 8);
  const user = createUserSync({
    displayName: `${baseName} ${suffix}`,
    primaryEmail: `${baseName.toLowerCase()}-${suffix}@example.com`,
  });
  createWorkspaceMembershipSync({
    workspaceId: DEFAULT_WORKSPACE_ID,
    userId: user.id,
    role,
  });
  return { id: user.id, displayName: user.displayName };
}

function seedChannelAttachment(input: {
  attachment: ReturnType<typeof persistWorkspaceAttachmentFromBytesSync>;
  speaker: string;
  speakerUserId?: string;
  role?: "agent" | "human";
  humanMemberNames: string[];
}): void {
  writeWorkspaceStateSync({
    ...readWorkspaceStateSync(),
    organizationName: "Northstar Labs",
    humanMembers: input.humanMemberNames.map((name) => ({ name, role: "Member" })),
    activeEmployees: [],
    channels: [{
      name: "tour visit",
      humanMemberNames: input.humanMemberNames,
      humanMembers: input.humanMemberNames.length,
      employeeNames: [],
    }],
    messages: [
      {
        id: "message-attachment-source",
        channel: "tour visit",
        speaker: input.speaker,
        speakerUserId: input.speakerUserId,
        role: input.role ?? "human",
        time: "2026-04-30T10:00:00.000Z",
        summary: "Attachment source",
        status: "completed",
        attachments: [input.attachment],
      },
    ],
    ledger: [],
  });
}

test("persistWorkspaceAttachmentFromBytesSync uploads bytes to TOS with shared metadata rules", () => {
  const attachment = persistWorkspaceAttachmentFromBytesSync({
    contentBytes: Buffer.from("fake-image-content", "utf8"),
    fileName: "nested/preview.png",
    mediaType: "application/octet-stream",
  });

  assert.equal(attachment.fileName, "nested/preview.png");
  assert.equal(attachment.mediaType, "image/png");
  assert.equal(attachment.kind, "image");
  assert.equal(attachment.sizeBytes, Buffer.byteLength("fake-image-content"));
  assert.match(attachment.storedPath, /^tos:\/\/test-bucket\/workspaces\/default\/attachments\/att-.*\/preview\.png$/);
  assert.equal(attachment.storageProvider, "tos");
  assert.equal(readTosObject(attachment), "fake-image-content");
});

test("persistWorkspaceAttachmentFromFileSync uploads runtime output files through the TOS pipeline", () => {
  const sourcePath = join(tempRoot, "runtime-output", "artifacts", "日本一周 itinerary.md");
  mkdirSync(join(tempRoot, "runtime-output", "artifacts"), { recursive: true });
  writeFileSync(sourcePath, "# 行程\n\n大阪", "utf8");

  const attachment = persistWorkspaceAttachmentFromFileSync({
    sourcePath,
    fileName: "reports/日本一周 itinerary.md",
  });

  assert.equal(attachment.fileName, "reports/日本一周 itinerary.md");
  assert.equal(attachment.mediaType, "text/markdown");
  assert.equal(attachment.kind, "file");
  assert.equal(attachment.sizeBytes, Buffer.byteLength("# 行程\n\n大阪"));
  assert.match(attachment.storedPath, /^tos:\/\/test-bucket\/workspaces\/default\/attachments\/att-.*\/日本一周-itinerary\.md$/);
  assert.equal(readTosObject(attachment), "# 行程\n\n大阪");
});

test("persistWorkspaceAttachmentFromBytesSync isolates non-default workspace objects by key prefix", () => {
  const attachment = persistWorkspaceAttachmentFromBytesSync({
    workspaceId: "workspace-mars",
    contentBytes: Buffer.from("workspace-specific", "utf8"),
    fileName: "reports/summary.txt",
    mediaType: "text/plain",
  });

  assert.match(attachment.storedPath, /^tos:\/\/test-bucket\/workspaces\/workspace-mars\/attachments\/att-.*\/summary\.txt$/);
  assert.equal(readTosObject(attachment), "workspace-specific");
});

test("deleteWorkspaceAttachmentsSync removes persisted TOS objects without touching metadata", () => {
  const attachment = persistWorkspaceAttachmentFromBytesSync({
    contentBytes: Buffer.from("cleanup-target", "utf8"),
    fileName: "cleanup/report.txt",
    mediaType: "text/plain",
  });

  deleteWorkspaceAttachmentsSync([attachment]);

  assert.equal(hasTosObject(attachment), false);
});

test("deleteChannelAttachmentSync lets the uploader delete their own channel file and deletes the TOS object", () => {
  resetWorkspaceStateSync();
  const uploader = createWorkspaceMember("Uploader", "member");
  const attachment = persistWorkspaceAttachmentFromBytesSync({
    contentBytes: Buffer.from("delete-me", "utf8"),
    fileName: "uploads/delete-me.txt",
    mediaType: "text/plain",
  });
  seedChannelAttachment({
    attachment,
    speaker: uploader.displayName,
    speakerUserId: uploader.id,
    humanMemberNames: [uploader.displayName],
  });

  const result = deleteChannelAttachmentSync({
    channelName: "tour visit",
    attachmentId: attachment.id,
    actorUserId: uploader.id,
    actorDisplayName: uploader.displayName,
  });

  const deletedAttachment = result.state.messages[0]?.attachments?.[0];
  assert.equal(result.removedFromMessage, true);
  assert.equal(result.physicalFileDeleted, true);
  assert.equal(result.retainedBecauseReferenced, false);
  assert.equal(deletedAttachment?.deletedByUserId, uploader.id);
  assert.ok(deletedAttachment?.deletedAt);
  assert.equal(hasTosObject(attachment), false);
});

test("deleteChannelAttachmentSync lets workspace admins delete any channel file", () => {
  resetWorkspaceStateSync();
  const uploader = createWorkspaceMember("Uploader", "member");
  const admin = createWorkspaceMember("Admin", "admin");
  const attachment = persistWorkspaceAttachmentFromBytesSync({
    contentBytes: Buffer.from("admin-delete", "utf8"),
    fileName: "uploads/admin-delete.txt",
    mediaType: "text/plain",
  });
  seedChannelAttachment({
    attachment,
    speaker: uploader.displayName,
    speakerUserId: uploader.id,
    humanMemberNames: [uploader.displayName],
  });

  deleteChannelAttachmentSync({
    channelName: "tour visit",
    attachmentId: attachment.id,
    actorUserId: admin.id,
    actorDisplayName: admin.displayName,
  });

  assert.equal(hasTosObject(attachment), false);
});

test("deleteChannelAttachmentSync rejects regular members deleting another member's file", () => {
  resetWorkspaceStateSync();
  const uploader = createWorkspaceMember("Uploader", "member");
  const viewer = createWorkspaceMember("Viewer", "member");
  const attachment = persistWorkspaceAttachmentFromBytesSync({
    contentBytes: Buffer.from("keep-other", "utf8"),
    fileName: "uploads/keep-other.txt",
    mediaType: "text/plain",
  });
  seedChannelAttachment({
    attachment,
    speaker: uploader.displayName,
    speakerUserId: uploader.id,
    humanMemberNames: [uploader.displayName, viewer.displayName],
  });

  assert.throws(
    () => deleteChannelAttachmentSync({
      channelName: "tour visit",
      attachmentId: attachment.id,
      actorUserId: viewer.id,
      actorDisplayName: viewer.displayName,
    }),
    /Forbidden/,
  );
  assert.equal(hasTosObject(attachment), true);
});

test("deleteChannelAttachmentSync rejects regular members deleting agent output files", () => {
  resetWorkspaceStateSync();
  const viewer = createWorkspaceMember("Viewer", "member");
  const attachment = persistWorkspaceAttachmentFromBytesSync({
    contentBytes: Buffer.from("keep-agent-output", "utf8"),
    fileName: "uploads/agent-output.txt",
    mediaType: "text/plain",
  });
  seedChannelAttachment({
    attachment,
    speaker: "Atlas",
    role: "agent",
    humanMemberNames: [viewer.displayName],
  });

  assert.throws(
    () => deleteChannelAttachmentSync({
      channelName: "tour visit",
      attachmentId: attachment.id,
      actorUserId: viewer.id,
      actorDisplayName: viewer.displayName,
    }),
    /Forbidden/,
  );
  assert.equal(hasTosObject(attachment), true);
});

test("deleteChannelAttachmentSync rejects workspace members without channel access", () => {
  resetWorkspaceStateSync();
  const uploader = createWorkspaceMember("Uploader", "member");
  const outsider = createWorkspaceMember("Outsider", "member");
  const attachment = persistWorkspaceAttachmentFromBytesSync({
    contentBytes: Buffer.from("keep-private", "utf8"),
    fileName: "uploads/keep-private.txt",
    mediaType: "text/plain",
  });
  seedChannelAttachment({
    attachment,
    speaker: uploader.displayName,
    speakerUserId: uploader.id,
    humanMemberNames: [uploader.displayName],
  });

  assert.throws(
    () => deleteChannelAttachmentSync({
      channelName: "tour visit",
      attachmentId: attachment.id,
      actorUserId: outsider.id,
      actorDisplayName: outsider.displayName,
    }),
    /Forbidden/,
  );
  assert.equal(hasTosObject(attachment), true);
});

test("deleteChannelAttachmentSync keeps TOS objects that knowledge pages still reference", () => {
  resetWorkspaceStateSync();
  const uploader = createWorkspaceMember("Uploader", "member");
  const attachment = persistWorkspaceAttachmentFromBytesSync({
    contentBytes: Buffer.from("# keep knowledge", "utf8"),
    fileName: "uploads/keep-knowledge.md",
    mediaType: "text/markdown",
  });
  seedChannelAttachment({
    attachment,
    speaker: uploader.displayName,
    speakerUserId: uploader.id,
    humanMemberNames: [uploader.displayName],
  });
  createKnowledgePageFromSharedDocumentSync({
    sourceType: "attachment",
    sourceId: attachment.id,
    createdBy: uploader.displayName,
    createdByType: "human",
  });

  const result = deleteChannelAttachmentSync({
    channelName: "tour visit",
    attachmentId: attachment.id,
    actorUserId: uploader.id,
    actorDisplayName: uploader.displayName,
  });

  assert.equal(result.physicalFileDeleted, false);
  assert.equal(result.retainedBecauseReferenced, true);
  assert.equal(hasTosObject(attachment), true);
});

test("deleteChannelAttachmentSync keeps TOS objects that channel document versions still reference", () => {
  resetWorkspaceStateSync();
  const uploader = createWorkspaceMember("Uploader", "member");
  const attachment = persistWorkspaceAttachmentFromBytesSync({
    contentBytes: Buffer.from("# keep document", "utf8"),
    fileName: "uploads/keep-document.md",
    mediaType: "text/markdown",
  });
  seedChannelAttachment({
    attachment,
    speaker: uploader.displayName,
    speakerUserId: uploader.id,
    humanMemberNames: [uploader.displayName],
  });
  createChannelDocumentFromAttachmentSync({
    channelName: "tour visit",
    attachmentId: attachment.id,
    createdBy: uploader.displayName,
    createdByType: "human",
  });

  const result = deleteChannelAttachmentSync({
    channelName: "tour visit",
    attachmentId: attachment.id,
    actorUserId: uploader.id,
    actorDisplayName: uploader.displayName,
  });

  assert.equal(result.physicalFileDeleted, false);
  assert.equal(result.retainedBecauseReferenced, true);
  assert.equal(hasTosObject(attachment), true);
});

test("deleteChannelSync deletes TOS objects that only belonged to the deleted channel", () => {
  const referenced = persistWorkspaceAttachmentFromBytesSync({
    contentBytes: Buffer.from("keep-me", "utf8"),
    fileName: "artifacts/delete-with-channel.txt",
    mediaType: "text/plain",
  });

  writeWorkspaceStateSync({
    ...readWorkspaceStateSync(),
    organizationName: "Northstar Labs",
    humanMembers: [{ name: "techwu", role: "Founder" }],
    activeEmployees: [],
    channels: [{
      name: "tour visit",
      humanMemberNames: ["techwu"],
      humanMembers: 1,
      employeeNames: [],
    }],
    channelDocuments: [],
    channelDocumentVersions: [],
    channelDocumentBlocks: [],
    channelDocumentAccesses: [],
    channelDocumentChangeSets: [],
    channelDocumentConflicts: [],
    channelDocumentPresences: [],
    channelDocumentRuns: [],
    channelDocumentRunSteps: [],
    materials: [],
    messages: [
      {
        id: "message-1",
        channel: "tour visit",
        speaker: "techwu",
        role: "human",
        time: "10:00",
        summary: "附件已保存。",
        status: "completed",
        attachments: [referenced],
      },
    ],
    directConversations: [],
    tasks: [],
    approvals: [],
    ledger: [],
  });

  deleteChannelSync("tour visit");

  assert.equal(hasTosObject(referenced), false);
});

test("resetWorkspaceStateSync removes runtime workspace files and abandoned execution roots", () => {
  const attachment = persistWorkspaceAttachmentFromBytesSync({
    contentBytes: Buffer.from("keep nothing", "utf8"),
    fileName: "artifacts/report.txt",
    mediaType: "text/plain",
  });
  writeWorkspaceStateSync({
    ...readWorkspaceStateSync(),
    messages: [{
      id: "message-reset-attachment",
      speaker: "Atlas",
      role: "agent",
      time: "10:00",
      summary: "Attachment scheduled for reset.",
      status: "completed",
      attachments: [attachment],
    }],
  });
  const workspaceHistoryPath = join(tempRoot, "data", "workspaces", "default", "channel-history", "general.md");
  mkdirSync(join(tempRoot, "data", "workspaces", "default", "channel-history"), { recursive: true });
  writeFileSync(workspaceHistoryPath, "# History", "utf8");

  const legacyHistoryPath = join(tempRoot, "data", "channel-history", "legacy.md");
  mkdirSync(join(tempRoot, "data", "channel-history"), { recursive: true });
  writeFileSync(legacyHistoryPath, "# Legacy history", "utf8");

  const legacyStagingPath = join(tempRoot, "data", "daemon-remote-staging", "queue-1", "agent-output.json");
  mkdirSync(join(tempRoot, "data", "daemon-remote-staging", "queue-1"), { recursive: true });
  writeFileSync(legacyStagingPath, "{}", "utf8");

  const legacyWorkDirPath = join(tempRoot, "data", "daemon", "workdirs", "channels", "general", "Atlas");
  mkdirSync(legacyWorkDirPath, { recursive: true });
  writeFileSync(join(legacyWorkDirPath, "last-message.txt"), "stale", "utf8");

  resetWorkspaceStateSync();

  assert.equal(hasTosObject(attachment), false);
  assert.equal(existsSync(workspaceHistoryPath), false);
  assert.equal(existsSync(legacyHistoryPath), false);
  assert.equal(existsSync(legacyStagingPath), false);
  assert.equal(existsSync(legacyWorkDirPath), false);
});

test.after(() => {
  setAttachmentStorageClientForTests(undefined);
  process.chdir(originalCwd);
  rmSync(tempRoot, { recursive: true, force: true });
});
