import assert from "node:assert/strict";
import test from "node:test";
import type { MessageAttachment } from "@dofe-agent/domain/workspace";
import {
  setAttachmentStorageClientForTests,
  type AttachmentStorageClient,
} from "../attachments/storage.ts";
import { createAttachmentFromChannelDocumentVersion, readMarkdownAttachmentContent } from "./files.ts";

const tosObjects = new Map<string, Uint8Array>();
const testTosStorage: AttachmentStorageClient = {
  async putObject() {
    throw new Error("Unexpected direct TOS upload in document file test.");
  },
  putObjectSync() {
    throw new Error("Unexpected direct TOS upload in document file test.");
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
  async headObject() {
    return null;
  },
  async deleteObject() {},
  deleteObjectSync() {},
  async createReadUrl() {
    return null;
  },
};

test.before(() => {
  process.env.NODE_ENV = "test";
  setAttachmentStorageClientForTests(testTosStorage);
});

test.after(() => {
  setAttachmentStorageClientForTests(undefined);
});

function persistTestAttachment(input: {
  id: string;
  contentBytes: Uint8Array;
  fileName: string;
  mediaType: string;
}): MessageAttachment {
  const storageKey = `workspaces/test/attachments/${input.id}/${input.fileName}`;
  tosObjects.set(storageKey, new Uint8Array(input.contentBytes));
  return {
    id: input.id,
    fileName: input.fileName,
    mediaType: input.mediaType,
    sizeBytes: input.contentBytes.byteLength,
    kind: "file",
    storedPath: `tos://test-bucket/${storageKey}`,
    storageProvider: "tos",
    storageBucket: "test-bucket",
    storageRegion: "cn-beijing",
    storageEndpoint: "https://tos-cn-beijing.volces.com",
    storageKey,
  };
}

test("createAttachmentFromChannelDocumentVersion uploads markdown bytes without a local intermediary", () => {
  const attachment = createAttachmentFromChannelDocumentVersion({
    document: {
      id: "doc-1",
      channelName: "tour visit",
      title: "大阪-濑户内海行程",
      slug: "osaka-trip",
      kind: "markdown",
      storageMode: "native",
      status: "active",
      currentVersionId: "ver-1",
      summary: "",
      lastEditorType: "human",
      createdBy: "techwu",
      updatedBy: "techwu",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    version: {
      id: "ver-1",
      documentId: "doc-1",
      contentMarkdown: "# 行程\n\n大阪",
      summary: "初版",
      createdBy: "techwu",
      createdByType: "human",
      triggerType: "manual",
      createdAt: new Date().toISOString(),
    },
    persistAttachment: (input) => persistTestAttachment({ id: "att-1", ...input }),
  });

  assert.equal(attachment.fileName, "osaka-trip.md");
  assert.match(attachment.storedPath, /^tos:\/\/test-bucket\//);
  assert.match(readMarkdownAttachmentContent(attachment), /大阪/);
});

test("readMarkdownAttachmentContent reads markdown from TOS", () => {
  const attachment = persistTestAttachment({
    id: "att-2",
    fileName: "plan.md",
    mediaType: "text/markdown",
    contentBytes: Buffer.from("# 计划\n\n宇治", "utf8"),
  });

  assert.match(readMarkdownAttachmentContent(attachment), /宇治/);
});

test("createAttachmentFromChannelDocumentVersion preserves Chinese file names", () => {
  const attachment = createAttachmentFromChannelDocumentVersion({
    document: {
      id: "doc-2",
      channelName: "trip room",
      title: "日本一周行程方案",
      slug: "日本一周行程方案",
      kind: "markdown",
      storageMode: "native",
      status: "active",
      currentVersionId: "ver-2",
      summary: "",
      lastEditorType: "agent",
      createdBy: "Atlas",
      updatedBy: "Atlas",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    version: {
      id: "ver-2",
      documentId: "doc-2",
      contentMarkdown: "# 日本一周行程方案\n\n大阪进出",
      summary: "协作版",
      createdBy: "Atlas",
      createdByType: "agent",
      triggerType: "agent",
      createdAt: new Date().toISOString(),
    },
    persistAttachment: (input) => persistTestAttachment({ id: "att-3", ...input }),
  });

  assert.equal(attachment.fileName, "日本一周行程方案.md");
  assert.match(readMarkdownAttachmentContent(attachment), /大阪进出/);
});
