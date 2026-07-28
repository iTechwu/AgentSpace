import assert from "node:assert/strict";
import test from "node:test";
import type { DofeAgentState } from "@dofe-agent/domain/workspace";
import { normalizeWorkspaceState } from "../shared/normalizers.ts";
import {
  buildChannelDocumentRecord,
  buildChannelDocumentVersionRecord,
  normalizeChannelDocument,
  normalizeChannelDocumentVersion,
} from "./model.ts";

test("channel document records default to native markdown", () => {
  const document = buildChannelDocumentRecord({
    id: "doc-1",
    channelName: "tour visit",
    title: "Trip notes",
    currentVersionId: "version-1",
    summary: "",
    lastEditorType: "human",
    createdBy: "techwu",
    updatedBy: "techwu",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    existingDocuments: [],
  });

  assert.equal(document.kind, "markdown");
  assert.equal(document.storageMode, "native");
  assert.equal(document.externalProvider, undefined);
});

test("channel document normalization preserves external document metadata", () => {
  const document = normalizeChannelDocument({
    id: "doc-1",
    channelName: "tour visit",
    title: "Project brief",
    slug: "budget-sheet",
    kind: "document",
    storageMode: "external",
    externalProvider: "notion",
    externalFileId: "page-123",
    externalUrl: "https://www.notion.so/page-123",
    externalRevisionId: "revision-1",
    currentVersionId: "version-1",
    summary: "Budget tracker",
    lastEditorType: "agent",
    createdBy: "Atlas",
    updatedBy: "Atlas",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  });

  assert.ok(document);
  assert.equal(document.kind, "document");
  assert.equal(document.storageMode, "external");
  assert.equal(document.externalProvider, "notion");
  assert.equal(document.externalFileId, "page-123");
  assert.equal(document.externalRevisionId, "revision-1");
});

test("channel document normalization preserves Feishu external metadata", () => {
  const document = normalizeChannelDocument({
    id: "feishu-doc-1",
    channelName: "tour visit",
    title: "Launch brief",
    slug: "launch-brief",
    kind: "document",
    storageMode: "external",
    externalProvider: "feishu",
    externalFileId: "doccnTest123",
    externalUrl: "https://example.feishu.cn/docx/doccnTest123",
    currentVersionId: "version-1",
    summary: "Launch brief",
    lastEditorType: "human",
    createdBy: "techwu",
    updatedBy: "techwu",
    createdAt: "2026-06-24T00:00:00.000Z",
    updatedAt: "2026-06-24T00:00:00.000Z",
  });

  assert.ok(document);
  assert.equal(document.storageMode, "external");
  assert.equal(document.externalProvider, "feishu");
  assert.equal(document.externalFileId, "doccnTest123");
  assert.equal(document.externalSyncStatus, "unknown");
});

test("legacy channel document normalization falls back to native markdown", () => {
  const document = normalizeChannelDocument({
    id: "legacy-doc",
    channelName: "tour visit",
    title: "Legacy notes",
    currentVersionId: "legacy-version",
    kind: "unknown",
    storageMode: "unknown",
    createdBy: "techwu",
  });

  assert.ok(document);
  assert.equal(document.kind, "markdown");
  assert.equal(document.storageMode, "native");
});

test("channel document versions preserve structured JSON content", () => {
  const version = buildChannelDocumentVersionRecord({
    id: "version-1",
    documentId: "doc-1",
    contentMarkdown: "",
    contentJson: {
      columns: [{ id: "item", name: "Item", type: "text" }],
      rows: [{ id: "row-1", cells: { item: "Data source audit" } }],
    },
    summary: "Structured sheet",
    createdBy: "techwu",
    createdByType: "human",
    triggerType: "manual",
    createdAt: "2026-05-01T00:00:00.000Z",
  });

  assert.deepEqual(version.contentJson, {
    columns: [{ id: "item", name: "Item", type: "text" }],
    rows: [{ id: "row-1", cells: { item: "Data source audit" } }],
  });

  const normalized = normalizeChannelDocumentVersion(version);
  assert.deepEqual(normalized?.contentJson, version.contentJson);
});

test("workspace normalization preserves legacy markdown documents as native documents", () => {
  const state = normalizeWorkspaceState({
    channelDocuments: [
      {
        id: "doc-1",
        channelName: "research",
        title: "Legacy notes",
        currentVersionId: "ver-1",
      },
    ] as unknown as DofeAgentState["channelDocuments"],
    channelDocumentVersions: [
      {
        id: "ver-1",
        documentId: "doc-1",
        contentMarkdown: "# Legacy",
        createdBy: "Mina",
      },
    ] as unknown as DofeAgentState["channelDocumentVersions"],
  });

  assert.equal(state.channelDocuments[0]?.kind, "markdown");
  assert.equal(state.channelDocuments[0]?.storageMode, "native");
  assert.equal(state.channelDocuments[0]?.externalSyncStatus, undefined);
});
