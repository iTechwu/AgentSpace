import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAttachmentFromChannelDocumentVersion, readMarkdownAttachmentContent } from "./files.ts";

test("createAttachmentFromChannelDocumentVersion delegates attachment persistence with markdown content", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "dofe-agent-doc-export-"));
  let persistedSourcePath = "";
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
    persistAttachment: ({ sourcePath, fileName, mediaType }) => {
      persistedSourcePath = sourcePath;
      return {
        id: "att-1",
        fileName: fileName ?? "",
        mediaType: mediaType ?? "text/markdown",
        sizeBytes: 8,
        kind: "file",
        storedPath: sourcePath,
      };
    },
    tempDirPath: tempDir,
  });

  assert.equal(attachment.fileName, "osaka-trip.md");
  assert.match(persistedSourcePath, /osaka-trip\.md$/);
  const content = readMarkdownAttachmentContent({
    id: "att-1",
    fileName: attachment.fileName,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
    storedPath: persistedSourcePath,
  });
  assert.match(content, /大阪/);

  rmSync(tempDir, { recursive: true, force: true });
});

test("readMarkdownAttachmentContent returns stored markdown content", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "dofe-agent-doc-import-"));
  const filePath = join(tempDir, "plan.md");
  writeFileSync(filePath, "# 计划\n\n宇治", "utf8");

  const content = readMarkdownAttachmentContent({
    id: "att-2",
    fileName: "plan.md",
    mediaType: "text/markdown",
    sizeBytes: 12,
    kind: "file",
    storedPath: filePath,
  });

  assert.match(content, /宇治/);
  rmSync(tempDir, { recursive: true, force: true });
});

test("createAttachmentFromChannelDocumentVersion preserves Chinese file names", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "dofe-agent-doc-export-"));
  let persistedSourcePath = "";
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
    persistAttachment: ({ sourcePath, fileName, mediaType }) => {
      persistedSourcePath = sourcePath;
      return {
        id: "att-2",
        fileName: fileName ?? "",
        mediaType: mediaType ?? "text/markdown",
        sizeBytes: 16,
        kind: "file",
        storedPath: sourcePath,
      };
    },
    tempDirPath: tempDir,
  });

  assert.equal(attachment.fileName, "日本一周行程方案.md");
  assert.match(persistedSourcePath, /日本一周行程方案\.md$/);

  rmSync(tempDir, { recursive: true, force: true });
});
