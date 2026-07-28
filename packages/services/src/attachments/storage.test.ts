import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAttachmentStorageKey,
  sha256Hex,
} from "./storage.ts";

test("attachment content hashes remain stable for TOS metadata", () => {
  assert.equal(
    sha256Hex(Buffer.from("storage bytes", "utf8")),
    "62025326492ddeada4ec6738b2a1c0ba11159328f154787738e92dc11f8b065c",
  );
});

test("object storage keys are workspace-scoped, date-partitioned, and sanitized", () => {
  const key = buildAttachmentStorageKey({
    workspaceId: "workspace/mars",
    attachmentId: "att:01",
    fileName: "../reports/日本一周 itinerary.md",
    createdAt: new Date("2026-05-11T12:00:00.000Z"),
  });

  assert.equal(
    key,
    "workspaces/workspace-mars/attachments/2026/05/att_01/reports-_itinerary.md",
  );
});
